import { contentToText } from "../content-parts.js";
import type { ChatMessage } from "../openai.js";
import type { ClientToolResult } from "./native.js";

export interface BridgeResumePlan {
  results: ClientToolResult[];
}

/**
 * Decide whether a follow-up request's delta messages resume a paused
 * client-tool run. A resumable delta contains only:
 *
 * - assistant messages echoing the pending tool calls (every id pending), and
 * - `role: "tool"` results for pending call ids.
 *
 * Anything else (new user input, unknown call ids, edited history) returns
 * undefined: the paused run is aborted and the turn falls back to a normal
 * send that replays the delta as prompt text.
 */
export function planBridgeResume(
  deltaMessages: ChatMessage[],
  pendingIds: ReadonlySet<string>,
): BridgeResumePlan | undefined {
  const results = new Map<string, ClientToolResult>();

  for (const message of deltaMessages) {
    if (message.role === "assistant") {
      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) return undefined;
      if (!toolCalls.every((call) => pendingIds.has(call.id))) {
        return undefined;
      }
      continue;
    }
    if (message.role === "tool") {
      const callId = message.tool_call_id;
      if (!callId || !pendingIds.has(callId)) return undefined;
      results.set(callId, { id: callId, text: contentToText(message.content) });
      continue;
    }
    return undefined;
  }

  if (results.size === 0) return undefined;
  return { results: [...results.values()] };
}
