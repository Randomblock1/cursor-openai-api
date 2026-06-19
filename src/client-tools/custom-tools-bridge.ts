import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import {
  briefToolLine,
  splitToolTiers,
  terseInputSchema,
  type ToolTierPolicy,
} from "./catalog.js";
import { isRecord } from "./guards.js";
import type { ClientToolSpec, ParsedToolCall } from "./types.js";

// Returned to the SDK agent loop from a captured client-tool `execute`. The run
// is cancelled the instant a call is captured, so the model never actually
// consumes this — it exists only to satisfy the callback's return contract
// without leaking a fabricated result into the (discarded) run.
const CAPTURE_SENTINEL =
  "[routed-to-client] This tool executes on the caller's side. The call has " +
  "been handed back to the caller; its TOOL RESULT arrives on the next turn.";

/**
 * Schedules the (single) deferred cancel and returns a function that cancels
 * that schedule. The default defers to the next macrotask via `setTimeout`,
 * which fires only after the current synchronous stack AND the entire microtask
 * queue have drained — so a batch of parallel `execute` callbacks dispatched
 * synchronously or across `await` continuations is fully recorded before cancel
 * runs. Injectable so tests can drive the timing deterministically.
 */
export type CancelScheduler = (fire: () => void) => () => void;

const macrotaskScheduler: CancelScheduler = (fire) => {
  const timer = setTimeout(fire, 0);
  return () => clearTimeout(timer);
};

export interface ClientToolCaptureSinkOptions {
  // Override how the cancel is deferred after captures stop arriving. Defaults
  // to a next-macrotask scheduler (see `macrotaskScheduler`).
  scheduleCancel?: CancelScheduler;
}

/**
 * Bridges the two tool planes. The caller's client tools are registered
 * as SDK `customTools` (exposed via the synthetic `custom-user-tools` MCP
 * server), so when the model invokes one through Cursor's native tool channel
 * the call lands in `execute` here. We capture the call, cancel the run, and the
 * caller surfaces it as an OpenAI `tool_call`. This is the sole client-tool
 * channel — the model runs as a real Cursor agent and calls these tools
 * natively (there is no marker protocol).
 *
 * Parallel-capture guarantee (keystone): when the model emits N parallel tool
 * calls in one assistant turn, the SDK invokes our `execute` callback once per
 * call. The agent loop runs backend-side and streams those invocations to the
 * local runtime; issuing `run.cancel()` synchronously on the FIRST capture
 * aborts that stream and can drop the remaining calls 2..N before their
 * `execute` callbacks fire. To make capture deterministic we DEBOUNCE the
 * cancel: each `record()` (re)schedules a single deferred cancel, so the run is
 * only cancelled once the in-flight tool-call batch has drained. The "don't let
 * the SDK feed a placeholder result back and continue the run" guarantee is
 * preserved — cancel still fires (a macrotask later, far sooner than the model
 * could complete a continuation round-trip), and `agent-turn` surfaces the
 * captured calls whether the run ends "cancelled" or otherwise.
 */
export class ClientToolCaptureSink {
  private readonly calls: ParsedToolCall[] = [];
  private cancel?: () => void;
  private cancelInvoked = false;
  private clearScheduled?: () => void;
  private readonly schedule: CancelScheduler;

  constructor(options: ClientToolCaptureSinkOptions = {}) {
    this.schedule = options.scheduleCancel ?? macrotaskScheduler;
  }

  /**
   * Wire the run cancellation. `Agent.send` only returns the `Run` after the
   * run has started, so binding happens just after send while `execute` can
   * only fire later during streaming — but if a capture somehow raced ahead of
   * the bind, schedule the deferred cancel now so the run still stops.
   */
  bindCancel(cancel: () => void): void {
    this.cancel = cancel;
    if (this.calls.length > 0) this.scheduleCancel();
  }

  record(name: string, args: Record<string, unknown>): string {
    this.calls.push({ name, arguments: args });
    this.scheduleCancel();
    return CAPTURE_SENTINEL;
  }

  // Arm (or re-arm) the single deferred cancel. Trailing-debounce: every capture
  // clears the previously scheduled cancel and reschedules, so cancel only fires
  // after the parallel batch stops arriving. Fire-and-forget by design: awaiting
  // cancel inside `execute` would deadlock the run loop (it is awaiting this very
  // callback), and the deferral runs outside `execute` entirely.
  private scheduleCancel(): void {
    if (this.cancelInvoked) return;
    if (!this.cancel) return; // not bound yet; bindCancel will arm it.
    this.clearScheduled?.();
    this.clearScheduled = this.schedule(() => this.fireCancel());
  }

  private fireCancel(): void {
    if (this.cancelInvoked) return;
    if (!this.cancel || this.calls.length === 0) return;
    this.cancelInvoked = true;
    this.clearScheduled = undefined;
    this.cancel();
  }

  get captured(): ReadonlyArray<ParsedToolCall> {
    return this.calls;
  }

  hasCaptured(): boolean {
    return this.calls.length > 0;
  }
}

/**
 * Build the SDK `customTools` map from the request's client tool specs. Each
 * entry's `execute` routes the call into `sink` rather than running anything
 * locally.
 *
 * Progressive disclosure: when a `tier` policy is supplied, the long tail is
 * registered TERSELY to keep the native channel's token cost down.
 * `splitToolTiers` partitions the specs:
 *  - `full`  (resident / `mode: "full"`): full `description` + `inputSchema`,
 *    byte-for-byte identical to the legacy (no-tier) registration.
 *  - `brief` (long tail in `tiered`, or all tools in `brief`): a one-line
 *    `briefToolLine` description + a minimal `terseInputSchema` (arg names only).
 *    The caller still holds the real schema and validates on execution, so the
 *    model only needs name + arg names to emit a correct call.
 *
 * Omitting `tier` (or passing `mode: "full"`) preserves the legacy behavior
 * exactly. agent-turn.ts passes the resolved tier policy for the native
 * client-tool path.
 *
 * Future option (phase 2, intentionally not implemented here): instead of
 * pre-registering the long tail terse, expose `search_tools`/`expand_tool`
 * meta-tools that re-register a tool's FULL schema on demand per send — true
 * progressive disclosure with a round trip. Left as a documented option only.
 */
export function buildClientToolCustomTools(
  specs: ClientToolSpec[],
  sink: ClientToolCaptureSink,
  tier?: ToolTierPolicy,
): Record<string, SDKCustomTool> {
  const tools: Record<string, SDKCustomTool> = {};
  const split = tier ? splitToolTiers(specs, tier) : { full: specs, brief: [] };
  const briefNames = new Set(split.brief.map((s) => s.name));
  for (const spec of specs) {
    const execute = (args: Record<string, unknown>): string =>
      sink.record(spec.name, args);
    if (briefNames.has(spec.name)) {
      // Long-tail: terse one-line description + arg-names-only schema.
      tools[spec.name] = {
        description: briefToolLine(spec),
        inputSchema: terseInputSchema(spec) as Record<string, SDKJsonValue>,
        execute: (args) => execute(args as Record<string, unknown>),
      };
      continue;
    }
    // Resident / full tier: full schema, unchanged from the legacy build.
    tools[spec.name] = {
      ...(spec.description ? { description: spec.description } : {}),
      ...(isRecord(spec.parameters)
        ? { inputSchema: spec.parameters as Record<string, SDKJsonValue> }
        : {}),
      execute: (args) => execute(args as Record<string, unknown>),
    };
  }
  return tools;
}
