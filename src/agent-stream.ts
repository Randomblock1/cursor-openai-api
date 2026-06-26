import type { InteractionUpdate, ModelSelection, Run } from "@cursor/sdk";
import { ProxyError } from "./errors.js";
import { applyInteractionUpdate } from "./interaction-delta.js";
import type { ChatCompletionChunk } from "./openai.js";
import { cancelRunSafely } from "./run-lifecycle.js";
import type { StreamState } from "./stream.js";
import { chunksFromSdkMessage, isSdkMessage } from "./stream.js";
import type { TurnStreamContext } from "./turn-stream.js";
import { applyTurnEndedUsage } from "./usage.js";

export function captureTurnUsage(
  state: StreamState,
  update: InteractionUpdate,
): void {
  const usage = applyTurnEndedUsage(update, {
    reasoningText: state.reasoningText,
    completionText: state.text,
  });
  if (usage) state.usage = usage;
  if (update.type === "turn-ended" && update.usage?.cacheWriteTokens) {
    state.cursorMeta.cache_write_tokens = update.usage.cacheWriteTokens;
  }
}

export function buildSendOptions(
  state: StreamState,
  stream: TurnStreamContext,
  sdkModel: ModelSelection,
  writeChunk?: (chunk: ChatCompletionChunk) => Promise<void>,
) {
  return {
    model: sdkModel,
    onDelta: async ({ update }: { update: InteractionUpdate }) => {
      await applyInteractionUpdate(state, update, stream, writeChunk);
      captureTurnUsage(state, update);
    },
  };
}

export async function pumpSdkMessageStream(
  run: Run,
  state: StreamState,
  debugStream: boolean,
  writeChunk?: (chunk: ChatCompletionChunk) => Promise<void>,
): Promise<void> {
  for await (const event of run.stream()) {
    if (!isSdkMessage(event)) continue;
    for (const chunk of chunksFromSdkMessage(event, state, debugStream)) {
      if (writeChunk) await writeChunk(chunk);
    }
  }
}

/**
 * Liveness record for the stream watchdog. Updated on every emitted delta
 * (content streams via the `onDelta` callback, debug chunks via the pump — both
 * funnel through the same `writeChunk`), so it tracks what the *consumer* sees,
 * not raw SDK transport events.
 */
export interface StreamActivity {
  /** Epoch ms of the first emitted delta, or `undefined` until one is emitted. */
  firstDeltaAt: number | undefined;
  /** Epoch ms of the most recently emitted delta. */
  lastActivityAt: number;
}

export interface StreamWatchdogOptions {
  /** Max wait from `agent.send` to the first emitted delta. */
  ttfbTimeoutMs: number;
  /** Max gap between emitted deltas once streaming has started. */
  idleTimeoutMs: number;
  /** Epoch ms when `agent.send` was invoked; TTFB is measured from here. */
  sendStartedAt: number;
}

export interface StreamWatchdog {
  /**
   * Rejects with a 504 `ProxyError` when the TTFB or idle bound is exceeded
   * (after cancelling the run). Never resolves — race it against the stream.
   */
  readonly expired: Promise<never>;
  /** Cancel the watchdog. Idempotent; always call once the stream settles. */
  stop(): void;
}

// Upper bound on how often the watchdog re-checks; it shortens the next tick to
// the nearest deadline so small timeouts still fire promptly.
const WATCHDOG_MAX_TICK_MS = 1000;

/**
 * Watch an in-flight streaming run for two stall modes and cancel + 504 on
 * either: a TTFB stall (the run never produces a first delta) and an inter-delta
 * idle stall (streaming starts then goes silent). The idle clock resets on every
 * emitted delta via `activity`. This does not fix upstream latency — it converts
 * an indefinite silent hang into a bounded, observable error.
 */
export function startStreamWatchdog(
  run: Run,
  activity: StreamActivity,
  options: StreamWatchdogOptions,
): StreamWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const stop = () => {
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const expired = new Promise<never>((_, reject) => {
    // Recomputed each tick so a delta arriving mid-wait both flips out of the
    // TTFB phase and resets the idle clock.
    const remainingMs = (now: number) =>
      activity.firstDeltaAt === undefined
        ? options.sendStartedAt + options.ttfbTimeoutMs - now
        : activity.lastActivityAt + options.idleTimeoutMs - now;
    const schedule = (now: number) => {
      const delay = Math.min(WATCHDOG_MAX_TICK_MS, Math.max(0, remainingMs(now)));
      timer = setTimeout(tick, delay);
      timer.unref?.();
    };
    const fail = (message: string) => {
      stop();
      void cancelRunSafely(run);
      reject(new ProxyError(message, 504, "server_error", "upstream_timeout"));
    };
    function tick() {
      if (settled) return;
      const now = Date.now();
      if (remainingMs(now) > 0) {
        schedule(now);
        return;
      }
      fail(
        activity.firstDeltaAt === undefined
          ? `Upstream produced no output within ${options.ttfbTimeoutMs}ms ` +
              `(TTFB timeout); cancelled the run.`
          : `Upstream stalled mid-stream: no output for ${options.idleTimeoutMs}ms ` +
              `(idle timeout); cancelled the run.`,
      );
    }
    schedule(Date.now());
  });
  // When the stream finishes first, `expired` is left rejected-but-unawaited
  // after `stop()`; swallow that to avoid an unhandledRejection.
  expired.catch(() => {});

  return { expired, stop };
}
