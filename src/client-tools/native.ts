import type {
  SDKCustomTool,
  SDKCustomToolResult,
  SDKJsonValue,
} from "@cursor/sdk";
import { makeId } from "../ids.js";
import { isRecord } from "./guards.js";
import type { ClientToolSpec } from "./types.js";

/**
 * How long to wait after the first custom-tool invocation for additional
 * parallel invocations before finishing the response with
 * `finish_reason: "tool_calls"`. The agent loop blocks on unresolved tool
 * results, so anything that has not fired by then belongs to a later batch.
 */
export const TOOL_CALL_COLLECT_WINDOW_MS = 50;

export interface ClientToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ClientToolResult {
  id: string;
  text: string;
}

interface PendingEntry extends ClientToolCall {
  /** Emitted into the currently attached response segment. */
  emitted: boolean;
  settle: (result: SDKCustomToolResult) => void;
}

export type ClientToolCallEmitter = (call: ClientToolCall) => Promise<void>;

export function clientToolErrorResult(message: string): SDKCustomToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function mintCallId(sdkToolCallId: string | undefined): string {
  const cleaned = sdkToolCallId?.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  if (cleaned) return cleaned.startsWith("call") ? cleaned : `call_${cleaned}`;
  return makeId("call");
}

/**
 * Bridges Cursor SDK `customTools` callbacks onto the OpenAI client-executed
 * tool protocol. Each `execute` records a pending call and returns a promise
 * that stays unresolved until the client posts the tool result on a follow-up
 * request (`provideResults`) or the turn is torn down (`settleAll`).
 *
 * One coordinator lives for the whole agent run, across every HTTP response
 * segment the run spans. `armSegment`/`detachSegment` scope it to the
 * response currently being streamed.
 */
export class ClientToolCoordinator {
  private readonly pending = new Map<string, PendingEntry>();
  private emitter: ClientToolCallEmitter | undefined;
  private pauseResolve: (() => void) | undefined;
  private pauseScheduled = false;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes emitter writes so a pause never overtakes an in-flight emit. */
  private emitChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly collectWindowMs: number = TOOL_CALL_COLLECT_WINDOW_MS,
  ) {}

  buildCustomTools(specs: ClientToolSpec[]): Record<string, SDKCustomTool> {
    const tools: Record<string, SDKCustomTool> = {};
    for (const spec of specs) {
      tools[spec.name] = {
        ...(spec.description !== undefined
          ? { description: spec.description }
          : {}),
        ...(isRecord(spec.parameters)
          ? { inputSchema: spec.parameters as Record<string, SDKJsonValue> }
          : {}),
        execute: (args, context) =>
          this.handleExecute(spec.name, args, context?.toolCallId),
      };
    }
    return tools;
  }

  /**
   * Bind the coordinator to a response segment. The returned promise resolves
   * when the segment should finish with `finish_reason: "tool_calls"`.
   */
  armSegment(emitter: ClientToolCallEmitter): Promise<void> {
    this.emitter = emitter;
    this.pauseScheduled = false;
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  /** Unbind from the current response segment. */
  detachSegment(): void {
    this.emitter = undefined;
    this.pauseResolve = undefined;
    this.pauseScheduled = false;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = undefined;
    }
    for (const entry of this.pending.values()) entry.emitted = false;
  }

  /**
   * Emit every pending call not yet surfaced in the current segment. Used on
   * resume so calls the client has not answered are (re-)presented in the new
   * response. Returns the number of calls emitted.
   */
  async flushPendingCalls(): Promise<number> {
    const emitter = this.emitter;
    if (!emitter) return 0;
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.emitted) continue;
      entry.emitted = true;
      count += 1;
      const call: ClientToolCall = {
        id: entry.id,
        name: entry.name,
        argumentsJson: entry.argumentsJson,
      };
      this.emitChain = this.emitChain.then(() => emitter(call)).catch(() => {});
    }
    await this.emitChain;
    return count;
  }

  /** Resolve pending calls with client-provided tool results. */
  provideResults(results: ClientToolResult[]): void {
    for (const result of results) {
      const entry = this.pending.get(result.id);
      if (!entry) continue;
      this.pending.delete(result.id);
      entry.settle(result.text);
    }
  }

  /** Resolve every outstanding call (teardown, timeout, stateless mode). */
  settleAll(result: SDKCustomToolResult): void {
    for (const entry of this.pending.values()) entry.settle(result);
    this.pending.clear();
  }

  hasPendingCalls(): boolean {
    return this.pending.size > 0;
  }

  pendingIds(): Set<string> {
    return new Set(this.pending.keys());
  }

  /** Ask the current segment to finish with `finish_reason: "tool_calls"`. */
  requestPause(): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = undefined;
    }
    this.resolvePauseAfterEmits();
  }

  private schedulePause(): void {
    if (this.pauseScheduled || !this.pauseResolve) return;
    this.pauseScheduled = true;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = undefined;
      this.resolvePauseAfterEmits();
    }, this.collectWindowMs);
    this.pauseTimer.unref?.();
  }

  private resolvePauseAfterEmits(): void {
    const resolve = this.pauseResolve;
    if (!resolve) return;
    this.pauseResolve = undefined;
    // The pause finishes the response; any tool_calls chunk still being
    // written must land first or the closed sink would drop it.
    void this.emitChain.then(resolve, resolve);
  }

  private handleExecute(
    name: string,
    args: Record<string, SDKJsonValue> | undefined,
    sdkToolCallId: string | undefined,
  ): Promise<SDKCustomToolResult> {
    return new Promise<SDKCustomToolResult>((resolve) => {
      const entry: PendingEntry = {
        id: mintCallId(sdkToolCallId),
        name,
        argumentsJson: JSON.stringify(args ?? {}),
        emitted: false,
        settle: resolve,
      };
      this.pending.set(entry.id, entry);

      const emitter = this.emitter;
      if (emitter) {
        entry.emitted = true;
        this.emitChain = this.emitChain
          .then(() =>
            emitter({
              id: entry.id,
              name: entry.name,
              argumentsJson: entry.argumentsJson,
            }),
          )
          .catch(() => {});
        // Give sibling parallel calls a beat to arrive, then hand the batch
        // to the client.
        this.schedulePause();
      }
    });
  }
}
