import { describe, expect, test } from "bun:test";
import {
  buildClientToolCustomTools,
  ClientToolCaptureSink,
} from "../src/client-tools/custom-tools-bridge.js";
import { toOpenAiToolCalls } from "../src/client-tools/openai-map.js";
import type { ClientToolSpec } from "../src/client-tools/types.js";

// Parallel tool_call surfacing + pairing.
//
// This models a client emitting N parallel tool calls in one assistant turn
// (native client-tool mode). The proxy must:
//   1. capture ALL N native invocations (debounced cancel), and
//   2. map each captured call to a DISTINCT OpenAI `tool_call` id with the right
//      name + arguments, so the client can pair each result by `tool_call_id`.
// No live model is needed — the SDK's parallel dispatch is simulated by invoking
// each customTool's `execute`, then the captured batch is mapped end-to-end.

const subtaskSpec: ClientToolSpec = {
  name: "run_subtask",
  description: "Run a subtask",
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

describe("parallel run_subtask capture -> distinct paired tool_calls", () => {
  test("N=4 parallel captures surface as 4 distinct, correctly-paired tool_calls", () => {
    const sched = manualScheduler();
    const sink = new ClientToolCaptureSink({ scheduleCancel: sched.scheduleCancel });
    const tools = buildClientToolCustomTools([subtaskSpec], sink);

    let capturedAtCancel = -1;
    sink.bindCancel(() => {
      capturedAtCancel = sink.captured.length;
    });

    // Four sibling subtasks in a single turn, each with distinct args.
    const goals = ["audit auth", "profile latency", "fix flaky test", "write docs"];
    for (const goal of goals) {
      tools.run_subtask.execute({ goal, context: "/workspace" }, {});
    }

    // Cancel is armed but not yet fired — the whole batch is still draining.
    expect(sched.pending()).toBe(true);
    sched.fire();

    // All four were in hand at cancel time (Spike A guarantee).
    expect(capturedAtCancel).toBe(4);
    expect(sink.captured).toHaveLength(4);

    const calls = toOpenAiToolCalls({
      toolCalls: [...sink.captured],
      tools: [subtaskSpec],
      responseId: "chatcmpl_parallel4",
    });

    expect(calls).toHaveLength(4);
    // All ids are distinct (the client pairs results by tool_call_id).
    expect(new Set(calls.map((c) => c.id)).size).toBe(4);
    // Every call resolved to the run_subtask spec name.
    expect(calls.every((c) => c.function.name === "run_subtask")).toBe(true);
    // Arguments survive intact and stay paired to the right call, in order.
    expect(calls.map((c) => JSON.parse(c.function.arguments).goal)).toEqual(goals);
    for (const call of calls) {
      expect(JSON.parse(call.function.arguments).context).toBe("/workspace");
    }
  });

  test("ids are positionally distinct (call_<suffix>_<index>) for N=3", () => {
    const sched = manualScheduler();
    const sink = new ClientToolCaptureSink({ scheduleCancel: sched.scheduleCancel });
    sink.bindCancel(() => {});

    sink.record("run_subtask", { goal: "one" });
    sink.record("run_subtask", { goal: "two" });
    sink.record("run_subtask", { goal: "three" });
    sched.fire();

    const calls = toOpenAiToolCalls({
      toolCalls: [...sink.captured],
      tools: [subtaskSpec],
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
        { name: "run_subtask", arguments: { goal: "a" } },
        { name: "run_subtask", arguments: { goal: "b" } },
      ],
      tools: [subtaskSpec],
      responseId: "chatcmpl_same",
      startIndex: 0,
    });
    const second = toOpenAiToolCalls({
      toolCalls: [
        { name: "run_subtask", arguments: { goal: "c" } },
        { name: "run_subtask", arguments: { goal: "d" } },
      ],
      tools: [subtaskSpec],
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
      subtaskSpec,
      { name: "store_note", parameters: { type: "object", properties: { action: { type: "string" } } } },
      { name: "search_docs", parameters: { type: "object", properties: { query: { type: "string" } } } },
    ];
    const sched = manualScheduler();
    const sink = new ClientToolCaptureSink({ scheduleCancel: sched.scheduleCancel });
    const tools = buildClientToolCustomTools(specs, sink);
    sink.bindCancel(() => {});

    tools.run_subtask.execute({ goal: "spawn worker" }, {});
    tools.store_note.execute({ action: "add" }, {});
    tools.search_docs.execute({ query: "auth refactor" }, {});
    sched.fire();

    expect(sink.captured).toHaveLength(3);

    const calls = toOpenAiToolCalls({
      toolCalls: [...sink.captured],
      tools: specs,
      responseId: "chatcmpl_mixed",
    });

    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
    expect(calls.map((c) => c.function.name)).toEqual([
      "run_subtask",
      "store_note",
      "search_docs",
    ]);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ goal: "spawn worker" });
    expect(JSON.parse(calls[1]!.function.arguments)).toEqual({ action: "add" });
    expect(JSON.parse(calls[2]!.function.arguments)).toEqual({ query: "auth refactor" });
  });

  test("real-timer parallel dispatch (await continuations) still surfaces all N", async () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools([subtaskSpec], sink);
    let capturedAtCancel = -1;
    sink.bindCancel(() => {
      capturedAtCancel = sink.captured.length;
    });

    // First call lands synchronously, the rest across microtask continuations —
    // the default macrotask-deferred cancel must wait for the whole batch.
    tools.run_subtask.execute({ goal: "g0" }, {});
    await Promise.resolve();
    tools.run_subtask.execute({ goal: "g1" }, {});
    await Promise.resolve();
    tools.run_subtask.execute({ goal: "g2" }, {});

    await new Promise((r) => setTimeout(r, 5));

    expect(capturedAtCancel).toBe(3);
    const calls = toOpenAiToolCalls({
      toolCalls: [...sink.captured],
      tools: [subtaskSpec],
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
