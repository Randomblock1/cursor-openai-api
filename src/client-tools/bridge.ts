import type { Run, RunResult } from "@cursor/sdk";
import { clientToolErrorResult, type ClientToolCoordinator } from "./native.js";
import type { InteractionRelay } from "./relay.js";

/**
 * A run paused mid-turn on client tool calls: the response finished with
 * `finish_reason: "tool_calls"` while the SDK run stays blocked inside the
 * customTools `execute` callbacks, waiting for the client's follow-up request
 * to deliver the tool results.
 */
export interface ClientToolBridge {
  agentId: string;
  sessionKey?: string;
  run: Run;
  relay: InteractionRelay;
  coordinator: ClientToolCoordinator;
  completion: Promise<RunResult>;
}

interface RegistryEntry {
  bridge: ClientToolBridge;
  timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_RESULT = clientToolErrorResult(
  "The API client did not return a tool result before the proxy timeout. Stop and report that the tool call was abandoned.",
);

export class ClientToolBridgeRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(bridge: ClientToolBridge, ttlMs: number): void {
    const previous = this.entries.get(bridge.agentId);
    if (previous) {
      clearTimeout(previous.timer);
      this.entries.delete(bridge.agentId);
      void abortBridge(previous.bridge, TIMEOUT_RESULT);
    }

    const timer = setTimeout(() => {
      const current = this.entries.get(bridge.agentId);
      if (current?.bridge !== bridge) return;
      this.entries.delete(bridge.agentId);
      void abortBridge(bridge, TIMEOUT_RESULT);
    }, ttlMs);
    timer.unref?.();

    // Nothing awaits the parked run while the client executes its tools;
    // keep a late failure from becoming an unhandled rejection.
    bridge.completion.catch(() => {});

    this.entries.set(bridge.agentId, { bridge, timer });
  }

  /** Remove and return the parked bridge for this agent, if any. */
  take(agentId: string): ClientToolBridge | undefined {
    const entry = this.entries.get(agentId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.entries.delete(agentId);
    return entry.bridge;
  }

  size(): number {
    return this.entries.size;
  }

  async clear(): Promise<void> {
    const parked = [...this.entries.values()];
    this.entries.clear();
    for (const entry of parked) {
      clearTimeout(entry.timer);
      await abortBridge(entry.bridge, TIMEOUT_RESULT);
    }
  }
}

/**
 * Tear down a parked run that can no longer be resumed: unblock the SDK's
 * pending `execute` callbacks, then cancel the run.
 */
export async function abortBridge(
  bridge: ClientToolBridge,
  result = clientToolErrorResult(
    "The conversation moved on before this tool call was answered.",
  ),
): Promise<void> {
  bridge.coordinator.settleAll(result);
  if (bridge.run.status === "running" && bridge.run.supports("cancel")) {
    await bridge.run.cancel().catch(() => {});
  }
  // Don't wait for the drained stream — a wedged run must not block new turns.
  void bridge.completion.catch(() => {});
}
