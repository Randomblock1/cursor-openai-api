import { describe, expect, test } from "bun:test";
import {
  ClientToolCoordinator,
  clientToolErrorResult,
  type ClientToolCall,
} from "../../src/client-tools/native.js";

const specs = [
  {
    name: "get_weather",
    description: "Look up weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  { name: "echo" },
];

function collector() {
  const calls: ClientToolCall[] = [];
  return {
    calls,
    emit: async (call: ClientToolCall) => {
      calls.push(call);
    },
  };
}

describe("ClientToolCoordinator", () => {
  test("buildCustomTools maps specs onto SDK custom tools", () => {
    const coordinator = new ClientToolCoordinator(5);
    const tools = coordinator.buildCustomTools(specs);

    expect(Object.keys(tools)).toEqual(["get_weather", "echo"]);
    expect(tools.get_weather?.description).toBe("Look up weather");
    expect(tools.get_weather?.inputSchema).toEqual(specs[0]!.parameters);
    expect(tools.echo?.inputSchema).toBeUndefined();
    expect(typeof tools.get_weather?.execute).toBe("function");
  });

  test("execute registers a pending call, emits it, and pauses the segment", async () => {
    const coordinator = new ClientToolCoordinator(5);
    const tools = coordinator.buildCustomTools(specs);
    const { calls, emit } = collector();

    const paused = coordinator.armSegment(emit);
    const resultPromise = tools.get_weather!.execute(
      { city: "NYC" },
      { toolCallId: "sdk-1" },
    );

    await paused;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("get_weather");
    expect(calls[0]?.argumentsJson).toBe('{"city":"NYC"}');
    expect(calls[0]?.id).toMatch(/^call/);
    expect(coordinator.hasPendingCalls()).toBe(true);

    coordinator.provideResults([{ id: calls[0]!.id, text: "Sunny" }]);
    expect(await resultPromise).toBe("Sunny");
    expect(coordinator.hasPendingCalls()).toBe(false);
  });

  test("collects parallel calls into one pause", async () => {
    const coordinator = new ClientToolCoordinator(20);
    const tools = coordinator.buildCustomTools(specs);
    const { calls, emit } = collector();

    const paused = coordinator.armSegment(emit);
    void tools.get_weather!.execute({ city: "NYC" }, {});
    void tools.echo!.execute({ text: "hi" }, {});

    await paused;

    expect(calls).toHaveLength(2);
    expect(coordinator.pendingIds().size).toBe(2);
  });

  test("flushPendingCalls re-emits unanswered calls on a new segment", async () => {
    const coordinator = new ClientToolCoordinator(5);
    const tools = coordinator.buildCustomTools(specs);
    const first = collector();

    const paused = coordinator.armSegment(first.emit);
    void tools.get_weather!.execute({ city: "NYC" }, {});
    await paused;
    coordinator.detachSegment();

    const second = collector();
    void coordinator.armSegment(second.emit);
    const flushed = await coordinator.flushPendingCalls();

    expect(flushed).toBe(1);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.id).toBe(first.calls[0]!.id);
  });

  test("calls that fire while detached surface via flushPendingCalls", async () => {
    const coordinator = new ClientToolCoordinator(5);
    const tools = coordinator.buildCustomTools(specs);

    void tools.echo!.execute({ text: "hi" }, {});
    expect(coordinator.hasPendingCalls()).toBe(true);

    const { calls, emit } = collector();
    void coordinator.armSegment(emit);
    expect(await coordinator.flushPendingCalls()).toBe(1);
    expect(calls[0]?.name).toBe("echo");
  });

  test("settleAll unblocks every pending execute", async () => {
    const coordinator = new ClientToolCoordinator(5);
    const tools = coordinator.buildCustomTools(specs);

    const a = tools.get_weather!.execute({ city: "NYC" }, {});
    const b = tools.echo!.execute({ text: "hi" }, {});
    coordinator.settleAll(clientToolErrorResult("abandoned"));

    const results = await Promise.all([a, b]);
    for (const result of results) {
      expect(result).toMatchObject({ isError: true });
    }
    expect(coordinator.hasPendingCalls()).toBe(false);
  });

  test("requestPause resolves the armed segment immediately", async () => {
    const coordinator = new ClientToolCoordinator(10_000);
    const { emit } = collector();
    const paused = coordinator.armSegment(emit);
    coordinator.requestPause();
    await paused;
  });

  test("derives stable call ids from SDK tool call ids", async () => {
    const coordinator = new ClientToolCoordinator(5);
    const tools = coordinator.buildCustomTools(specs);
    const { calls, emit } = collector();
    void coordinator.armSegment(emit);

    void tools.echo!.execute({}, { toolCallId: "toolu_abc/123" });
    await coordinator.flushPendingCalls();

    expect(calls[0]?.id).toBe("call_toolu_abc123");
  });

  test("mints distinct ids when sanitized SDK tool call ids collide", async () => {
    const coordinator = new ClientToolCoordinator(5);
    const tools = coordinator.buildCustomTools(specs);
    const { calls, emit } = collector();
    void coordinator.armSegment(emit);

    // Both sanitize to "call_toolu_abc123"; the second must not overwrite the
    // first pending entry (its settle would be lost and the run would hang).
    const a = tools.echo!.execute({}, { toolCallId: "toolu_abc/123" });
    const b = tools.echo!.execute({}, { toolCallId: "toolu_abc.123" });
    await coordinator.flushPendingCalls();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.id).toBe("call_toolu_abc123");
    expect(calls[1]?.id).not.toBe(calls[0]?.id);
    expect(coordinator.pendingIds().size).toBe(2);

    coordinator.provideResults([
      { id: calls[0]!.id, text: "first" },
      { id: calls[1]!.id, text: "second" },
    ]);
    expect(await a).toBe("first");
    expect(await b).toBe("second");
  });
});
