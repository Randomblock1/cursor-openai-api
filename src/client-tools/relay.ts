import type {
  InteractionUpdate,
  ModelSelection,
  Run,
  RunResult,
  SDKCustomTool,
  SDKMessage,
} from "@cursor/sdk";
import { captureTurnUsage } from "../agent-stream.js";
import { applyInteractionUpdate } from "../interaction-delta.js";
import type { ChatCompletionChunk } from "../openai.js";
import { chunksFromSdkMessage, isSdkMessage } from "../stream.js";
import type { StreamState } from "../stream.js";
import type { TurnStreamContext } from "../turn-stream.js";

export interface RelayTarget {
  state: StreamState;
  stream: TurnStreamContext;
  onChunk?: (chunk: ChatCompletionChunk) => Promise<void>;
}

type BufferedEvent =
  | { kind: "update"; update: InteractionUpdate }
  | { kind: "sdk"; event: SDKMessage };

/** Safety cap for events that arrive while no response segment is attached. */
const MAX_BUFFERED_EVENTS = 4096;

/**
 * Routes a run's SDK events into the HTTP response currently streaming them.
 * A client-tool run can span several chat-completion requests (tool_calls
 * pause → client executes → follow-up resumes), so the downstream target is
 * swappable; events that arrive between segments are buffered and replayed on
 * the next `attach`.
 */
export class InteractionRelay {
  private target: RelayTarget | undefined;
  private buffered: BufferedEvent[] = [];
  private queue: Promise<void> = Promise.resolve();

  attach(target: RelayTarget): Promise<void> {
    return this.enqueue(async () => {
      this.target = target;
      const backlog = this.buffered;
      this.buffered = [];
      for (const event of backlog) {
        await this.deliver(event, target);
      }
    });
  }

  detach(): void {
    this.target = undefined;
  }

  handleUpdate(update: InteractionUpdate): Promise<void> {
    return this.enqueue(() => this.route({ kind: "update", update }));
  }

  handleSdkMessage(event: SDKMessage): Promise<void> {
    return this.enqueue(() => this.route({ kind: "sdk", event }));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.catch(() => {}).then(operation);
    this.queue = run;
    return run;
  }

  private async route(event: BufferedEvent): Promise<void> {
    const target = this.target;
    if (!target) {
      if (this.buffered.length < MAX_BUFFERED_EVENTS) this.buffered.push(event);
      return;
    }
    await this.deliver(event, target);
  }

  private async deliver(
    event: BufferedEvent,
    target: RelayTarget,
  ): Promise<void> {
    if (event.kind === "update") {
      await applyInteractionUpdate(
        target.state,
        event.update,
        target.stream,
        target.onChunk,
      );
      captureTurnUsage(target.state, event.update);
      return;
    }
    for (const chunk of chunksFromSdkMessage(
      event.event,
      target.state,
      target.stream.policy.debugStream,
    )) {
      if (target.onChunk) await target.onChunk(chunk);
    }
  }
}

export function buildRelaySendOptions(
  relay: InteractionRelay,
  sdkModel: ModelSelection,
  customTools?: Record<string, SDKCustomTool>,
) {
  return {
    model: sdkModel,
    onDelta: async ({ update }: { update: InteractionUpdate }) => {
      await relay.handleUpdate(update);
    },
    ...(customTools && Object.keys(customTools).length > 0
      ? { local: { customTools } }
      : {}),
  };
}

/**
 * Drain the run's SDK message stream through the relay, then resolve with the
 * run's terminal result. Consumed exactly once per run; the returned promise
 * outlives individual response segments for bridged client-tool turns.
 */
export function startRunCompletion(
  run: Run,
  relay: InteractionRelay,
): Promise<RunResult> {
  return (async () => {
    for await (const event of run.stream()) {
      if (!isSdkMessage(event)) continue;
      await relay.handleSdkMessage(event);
    }
    return run.wait();
  })();
}
