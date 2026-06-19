import { describe, expect, test } from "bun:test";
import {
  buildClientToolCustomTools,
  ClientToolCaptureSink,
} from "../src/client-tools/custom-tools-bridge.js";
import { toOpenAiToolCalls } from "../src/client-tools/openai-map.js";
import type { ClientToolSpec } from "../src/client-tools/types.js";

// Parallel tool_call surfacing + pairing.
//
// This models the orchestrator emitting N parallel `delegate_task` calls in one
// assistant turn (native client-tool mode). The proxy must:
//   1. capture ALL N native invocations (debounced cancel), and
//   2. map each captured call to a DISTINCT OpenAI `tool_call` id with the right
//      name + arguments, so the engine can pair each result by `tool_call_id`.
// No live model is needed — the SDK's parallel dispatch is simulated by invoking
// each customTool's `execute`, then the captured batch is mapped end-to-end.

const delegateSpec: ClientToolSpec = {
  name: "delegate_task",
  description: "Spawn a subagent",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string" },
      context: { type: "string" },
    },
  },
};

// A synchronous, manually-fired scheduler so the debounced cancel timing is
// deterministic (mirrors custom-tools-bridge.test.ts). `fire()` invokes the most
// recently scheduled cancel callback.
function manualScheduler(): {
  scheduleCancel: (fire: () => void) => () => void;
  pending: () => boolean;
  fire: () => void;
} {
  let armed: (() => void) | undefined;
  return {
    scheduleCancel: (cb) => {
      armed = cb;
      return () => {
        armed = undefined;
      };
    },
    pending: () => armed !== undefined,
    fire: () => {
      armed?.();
    },
  };
}

describe("parallel delegate_task capture -> distinct paired tool_calls", () => {
  test("N=4 parallel captures surface as 4 distinct, correctly-paired tool_calls", () => {
    const sched = manualScheduler();
    const sink = new ClientToolCaptureSink({ scheduleCancel: sched.scheduleCancel });
    const tools = buildClientToolCustomTools([delegateSpec], sink);

    let capturedAtCancel = -1;
    sink.bindCancel(() => {
      capturedAtCancel = sink.captured.length;
    });

    // Four sibling subagent spawns in a single turn, each with distinct args.
    const goals = ["audit auth", "profile latency", "fix flaky test", "write docs"];
    for (const goal of goals) {
      tools.delegate_task.execute({ goal, context: "/ws/symbiosis" }, {});
    }

    // Cancel is armed but not yet fired — the whole batch is still draining.
    expect(sched.pending()).toBe(true);
    sched.fire();

    // All four were in hand at cancel time (Spike A guarantee).
    expect(capturedAtCancel).toBe(4);
    expect(sink.captured).toHaveLength(4);

    const calls = toOpenAiToolCalls({
      toolCalls: [...sink.captured],
      tools: [delegateSpec],
      responseId: "chatcmpl_parallel4",
    });

    expect(calls).toHaveLength(4);
    // All ids are distinct (the engine pairs results by tool_call_id).
    expect(new Set(calls.map((c) => c.id)).size).toBe(4);
    // Every call resolved to the delegate_task spec name.
    expect(calls.every((c) => c.function.name === "delegate_task")).toBe(true);
    // Arguments survive intact and stay paired to the right call, in order.
    expect(calls.map((c) => JSON.parse(c.function.arguments).goal)).toEqual(goals);
    for (const call of calls) {
      expect(JSON.parse(call.function.arguments).context).toBe("/ws/symbiosis");
    }
  });

  test("ids are positionally distinct (call_<suffix>_<index>) for N=3", () => {
    const sched = manualScheduler();
    const sink = new ClientToolCaptureSink({ scheduleCancel: sched.scheduleCancel });
    sink.bindCancel(() => {});

    sink.record("delegate_task", { goal: "one" });
    sink.record("delegate_task", { goal: "two" });
    sink.record("delegate_task", { goal: "three" });
    sched.fire();

    const calls = toOpenAiToolCalls({
      toolCalls: [...sink.captured],
      tools: [delegateSpec],
      responseId: "chatcmpl_xyz789",
    });

    expect(calls.map((c) => c.id)).toEqual([
      "call_chatcmplxyz789_0",
      "call_chatcmplxyz789_1",
      "call_chatcmplxyz789_2",
    ]);
  });

  test("startIndex offsets ids without collisions (batched mapping)", () => {
    const first = toOpenAiToolCalls({
      toolCalls: [
        { name: "delegate_task", arguments: { goal: "a" } },
        { name: "delegate_task", arguments: { goal: "b" } },
      ],
      tools: [delegateSpec],
      responseId: "chatcmpl_same",
      startIndex: 0,
    });
    const second = toOpenAiToolCalls({
      toolCalls: [
        { name: "delegate_task", arguments: { goal: "c" } },
        { name: "delegate_task", arguments: { goal: "d" } },
      ],
      tools: [delegateSpec],
      responseId: "chatcmpl_same",
      startIndex: 2,
    });
    const ids = [...first, ...second].map((c) => c.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual([
      "call_chatcmplsame_0",
      "call_chatcmplsame_1",
      "call_chatcmplsame_2",
      "call_chatcmplsame_3",
    ]);
  });

  test("mixed parallel tool names each keep their own name + args", () => {
    const specs: ClientToolSpec[] = [
      delegateSpec,
      { name: "memory", parameters: { type: "object", properties: { action: { type: "string" } } } },
      { name: "session_search", parameters: { type: "object", properties: { query: { type: "string" } } } },
    ];
    const sched = manualScheduler();
    const sink = new ClientToolCaptureSink({ scheduleCancel: sched.scheduleCancel });
    const tools = buildClientToolCustomTools(specs, sink);
    sink.bindCancel(() => {});

    tools.delegate_task.execute({ goal: "spawn worker" }, {});
    tools.memory.execute({ action: "add" }, {});
    tools.session_search.execute({ query: "auth refactor" }, {});
    sched.fire();

    expect(sink.captured).toHaveLength(3);

    const calls = toOpenAiToolCalls({
      toolCalls: [...sink.captured],
      tools: specs,
      responseId: "chatcmpl_mixed",
    });

    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
    expect(calls.map((c) => c.function.name)).toEqual([
      "delegate_task",
      "memory",
      "session_search",
    ]);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ goal: "spawn worker" });
    expect(JSON.parse(calls[1]!.function.arguments)).toEqual({ action: "add" });
    expect(JSON.parse(calls[2]!.function.arguments)).toEqual({ query: "auth refactor" });
  });

  test("real-timer parallel dispatch (await continuations) still surfaces all N", async () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools([delegateSpec], sink);
    let capturedAtCancel = -1;
    sink.bindCancel(() => {
      capturedAtCancel = sink.captured.length;
    });

    // First call lands synchronously, the rest across microtask continuations —
    // the default macrotask-deferred cancel must wait for the whole batch.
    tools.delegate_task.execute({ goal: "g0" }, {});
    await Promise.resolve();
    tools.delegate_task.execute({ goal: "g1" }, {});
    await Promise.resolve();
    tools.delegate_task.execute({ goal: "g2" }, {});

    await new Promise((r) => setTimeout(r, 5));

    expect(capturedAtCancel).toBe(3);
    const calls = toOpenAiToolCalls({
      toolCalls: [...sink.captured],
      tools: [delegateSpec],
      responseId: "chatcmpl_rt",
    });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
    expect(calls.map((c) => JSON.parse(c.function.arguments).goal)).toEqual([
      "g0",
      "g1",
      "g2",
    ]);
  });
});
