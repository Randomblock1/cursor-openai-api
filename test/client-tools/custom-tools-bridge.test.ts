import { describe, expect, test } from "bun:test";
import {
  ClientToolCaptureSink,
  buildClientToolCustomTools,
} from "../../src/client-tools/custom-tools-bridge.js";
import type { ClientToolSpec } from "../../src/client-tools/types.js";

const specs: ClientToolSpec[] = [
  {
    name: "search_docs",
    description: "Search the indexed documents",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
  { name: "store_note" },
];

describe("buildClientToolCustomTools", () => {
  test("maps each spec to an SDK custom tool keyed by name", () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools(specs, sink);
    expect(Object.keys(tools).sort()).toEqual(["search_docs", "store_note"]);
    expect(tools.search_docs.description).toBe("Search the indexed documents");
    expect(tools.search_docs.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
    });
    // Tools without description/parameters omit those fields.
    expect(tools.store_note.description).toBeUndefined();
    expect(tools.store_note.inputSchema).toBeUndefined();
    expect(typeof tools.store_note.execute).toBe("function");
  });

  test("execute routes the call into the sink and returns a sentinel", () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools(specs, sink);
    const result = tools.search_docs.execute(
      { query: "auth refactor" },
      {},
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("routed-to-client");
    expect([...sink.captured]).toEqual([
      { name: "search_docs", arguments: { query: "auth refactor" } },
    ]);
    expect(sink.hasCaptured()).toBe(true);
  });
});

// A synchronous, manually-fired scheduler so cancel timing is deterministic in
// tests without relying on real timer/microtask interleaving. `fire()` invokes
// the most recently scheduled (debounced) cancel callback.
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

describe("ClientToolCaptureSink cancellation", () => {
  test("a captured call triggers the bound cancel exactly once", async () => {
    const sink = new ClientToolCaptureSink();
    let cancels = 0;
    sink.bindCancel(() => {
      cancels += 1;
    });
    sink.record("store_note", { action: "add" });
    sink.record("search_docs", { query: "x" });
    // Cancel is deferred (debounced) so the parallel batch can drain first.
    expect(cancels).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(cancels).toBe(1);
    expect(sink.captured).toHaveLength(2);
  });

  test("a capture that races ahead of bindCancel still cancels on bind", async () => {
    const sink = new ClientToolCaptureSink();
    sink.record("store_note", {});
    let cancelled = false;
    sink.bindCancel(() => {
      cancelled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelled).toBe(true);
  });

  test("no capture means cancel never fires", async () => {
    const sink = new ClientToolCaptureSink();
    let cancels = 0;
    sink.bindCancel(() => {
      cancels += 1;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(cancels).toBe(0);
    expect(sink.hasCaptured()).toBe(false);
  });
});

describe("ClientToolCaptureSink parallel capture (keystone)", () => {
  // The whole point of the deferral: when the model emits N parallel tool calls,
  // ALL N must be recorded before the run is cancelled. With a manual scheduler
  // we prove the full batch is in hand at the moment cancel fires.
  test("defers cancel until the full synchronous batch is captured", () => {
    const sched = manualScheduler();
    const sink = new ClientToolCaptureSink({
      scheduleCancel: sched.scheduleCancel,
    });
    let cancels = 0;
    let capturedAtCancel = -1;
    sink.bindCancel(() => {
      cancels += 1;
      capturedAtCancel = sink.captured.length;
    });

    sink.record("alpha", { a: 1 });
    sink.record("beta", { b: 2 });
    sink.record("gamma", { c: 3 });

    // Cancel is armed but not yet fired — the batch is still draining.
    expect(cancels).toBe(0);
    expect(sched.pending()).toBe(true);

    sched.fire();

    expect(cancels).toBe(1);
    expect(capturedAtCancel).toBe(3);
    expect(sink.captured).toHaveLength(3);
    expect([...sink.captured].map((c) => c.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  test("fires cancel only once even when re-armed across many captures", () => {
    const sched = manualScheduler();
    const sink = new ClientToolCaptureSink({
      scheduleCancel: sched.scheduleCancel,
    });
    let cancels = 0;
    sink.bindCancel(() => {
      cancels += 1;
    });
    for (let i = 0; i < 5; i += 1) sink.record(`tool_${i}`, { i });
    sched.fire();
    // A straggler arriving after the batch already cancelled must not re-arm.
    sink.record("late", {});
    sched.fire();
    expect(cancels).toBe(1);
    expect(sink.captured).toHaveLength(6);
  });

  test("real-timer path captures N>=3 parallel execute invocations", async () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools(
      [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
      sink,
    );
    let cancels = 0;
    let capturedAtCancel = -1;
    sink.bindCancel(() => {
      cancels += 1;
      capturedAtCancel = sink.captured.length;
    });

    // Simulate the SDK dispatching a parallel batch: the first call arrives
    // synchronously, the rest on subsequent microtasks (await continuations).
    // The default macrotask-deferred cancel must wait for the whole batch.
    tools.a.execute({ x: 1 }, {});
    await Promise.resolve();
    tools.b.execute({ x: 2 }, {});
    await Promise.resolve();
    tools.c.execute({ x: 3 }, {});
    await Promise.resolve();
    tools.d.execute({ x: 4 }, {});

    await new Promise((r) => setTimeout(r, 5));

    expect(cancels).toBe(1);
    expect(capturedAtCancel).toBe(4);
    expect(sink.captured).toHaveLength(4);
    expect([...sink.captured].map((c) => c.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
