import { describe, expect, test } from "bun:test";
import type { Run } from "@cursor/sdk";
import {
  startStreamWatchdog,
  type StreamActivity,
} from "../src/agent-stream.js";
import { ProxyError } from "../src/errors.js";
import { startSseHeartbeat } from "../src/openai-endpoint.js";
import type { SSEStreamingApi } from "hono/streaming";

function fakeRun(): { run: Run; cancelled: () => boolean } {
  let cancelled = false;
  const run = {
    supports: (op: string) => op === "cancel",
    cancel: async () => {
      cancelled = true;
    },
  } as unknown as Run;
  return { run, cancelled: () => cancelled };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startStreamWatchdog", () => {
  test("TTFB timeout fires -> 504 and cancels the run when no first delta", async () => {
    const { run, cancelled } = fakeRun();
    const activity: StreamActivity = {
      firstDeltaAt: undefined,
      lastActivityAt: Date.now(),
    };
    const watchdog = startStreamWatchdog(run, activity, {
      ttfbTimeoutMs: 20,
      idleTimeoutMs: 10_000,
      sendStartedAt: Date.now(),
    });

    const err = await watchdog.expired.catch((e) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as ProxyError).status).toBe(504);
    expect((err as ProxyError).code).toBe("upstream_timeout");
    expect((err as ProxyError).message).toMatch(/TTFB/);
    expect(cancelled()).toBe(true);
    watchdog.stop();
  });

  test("idle timeout fires -> 504 and cancels the run when streaming stalls", async () => {
    const { run, cancelled } = fakeRun();
    const activity: StreamActivity = {
      firstDeltaAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    const watchdog = startStreamWatchdog(run, activity, {
      ttfbTimeoutMs: 10_000,
      idleTimeoutMs: 20,
      sendStartedAt: Date.now(),
    });

    const err = await watchdog.expired.catch((e) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as ProxyError).status).toBe(504);
    expect((err as ProxyError).code).toBe("upstream_timeout");
    expect((err as ProxyError).message).toMatch(/idle/);
    expect(cancelled()).toBe(true);
    watchdog.stop();
  });

  test("idle clock resets on every delta so a steady stream is NOT killed", async () => {
    const { run, cancelled } = fakeRun();
    const activity: StreamActivity = {
      firstDeltaAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    const watchdog = startStreamWatchdog(run, activity, {
      ttfbTimeoutMs: 10_000,
      idleTimeoutMs: 80,
      sendStartedAt: Date.now(),
    });

    let rejected = false;
    watchdog.expired.catch(() => {
      rejected = true;
    });

    // Emit a delta every 25ms (well under the 80ms idle bound) for ~200ms.
    const beat = setInterval(() => {
      activity.lastActivityAt = Date.now();
    }, 25);
    await delay(200);
    clearInterval(beat);
    watchdog.stop();

    // Give any in-flight tick room to (incorrectly) fire.
    await delay(120);
    expect(rejected).toBe(false);
    expect(cancelled()).toBe(false);
  });

  test("stop() before expiry prevents the timeout from firing", async () => {
    const { run, cancelled } = fakeRun();
    const activity: StreamActivity = {
      firstDeltaAt: undefined,
      lastActivityAt: Date.now(),
    };
    const watchdog = startStreamWatchdog(run, activity, {
      ttfbTimeoutMs: 40,
      idleTimeoutMs: 40,
      sendStartedAt: Date.now(),
    });
    let rejected = false;
    watchdog.expired.catch(() => {
      rejected = true;
    });

    watchdog.stop();
    await delay(80);
    expect(rejected).toBe(false);
    expect(cancelled()).toBe(false);
  });
});

function fakeSseStream(): {
  stream: SSEStreamingApi;
  writes: string[];
} {
  const writes: string[] = [];
  const stream = {
    write: async (input: string | Uint8Array) => {
      writes.push(typeof input === "string" ? input : input.toString());
      return stream;
    },
  } as unknown as SSEStreamingApi;
  return { stream, writes };
}

describe("startSseHeartbeat", () => {
  test("emits SSE comment pings until stopped (i.e. before the first delta)", async () => {
    const { stream, writes } = fakeSseStream();
    const stop = startSseHeartbeat(stream, 20);

    await delay(70);
    const pingsWhileWaiting = writes.length;
    expect(pingsWhileWaiting).toBeGreaterThanOrEqual(2);
    expect(writes.every((w) => w === ": ping\n\n")).toBe(true);

    // First real delta arrives -> stop pinging.
    stop();
    await delay(70);
    expect(writes.length).toBe(pingsWhileWaiting);
  });

  test("is a no-op when the interval is <= 0", async () => {
    const { stream, writes } = fakeSseStream();
    const stop = startSseHeartbeat(stream, 0);
    await delay(40);
    stop();
    expect(writes.length).toBe(0);
  });
});
