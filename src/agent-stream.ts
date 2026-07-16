import type { InteractionUpdate } from "@cursor/sdk";
import type { StreamState } from "./stream.js";
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
