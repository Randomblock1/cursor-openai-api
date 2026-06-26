import type { SDKMessage } from "@cursor/sdk";
import { attachCursorMeta } from "./cursor-meta.js";
import type { CompletionFinishReason } from "./finish-reason.js";
import { resolveFinishReason } from "./finish-reason.js";
import type { ChatCompletionChunk, CursorCompletionMeta, OpenAIUsage } from "./openai.js";
import { makeCompletionId } from "./openai.js";
import { normalizeToolArguments } from "./tool-args.js";

export interface StreamState {
  completionId: string;
  model: string;
  created: number;
  text: string;
  pendingText: string;
  reasoningText: string;
  usage?: OpenAIUsage;
  maxTokens?: number;
  cursorMeta: CursorCompletionMeta;
  toolCalls: Map<
    string,
    { id: string; name: string; arguments: string; index: number }
  >;
  nextToolIndex: number;
}

export function isSdkMessage(event: unknown): event is SDKMessage {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    typeof Reflect.get(event, "type") === "string"
  );
}

export function createStreamState(
  model: string,
  options?: { maxTokens?: number; agentId?: string },
): StreamState {
  return {
    completionId: makeCompletionId(),
    model,
    created: Math.floor(Date.now() / 1000),
    text: "",
    pendingText: "",
    reasoningText: "",
    maxTokens: options?.maxTokens,
    cursorMeta: { agent_id: options?.agentId ?? "" },
    toolCalls: new Map(),
    nextToolIndex: 0,
  };
}

export function bufferAssistantText(state: StreamState, text: string): void {
  state.pendingText += text;
}

// OpenCode renders all content deltas in one text part, so delay final text
// until turn-end when reasoning needs to appear first.
export function flushBufferedAssistantText(
  state: StreamState,
): ChatCompletionChunk | null {
  const text = state.pendingText;
  state.pendingText = "";
  return chunkFromAssistantText(state, text);
}

// Interrupted buffered text is preamble, not the final answer.
export function flushBufferedAssistantTextAsReasoning(
  state: StreamState,
): ChatCompletionChunk | null {
  const text = state.pendingText;
  state.pendingText = "";
  return chunkFromReasoningText(state, text);
}

export function mergeCursorMetaFromSdkMessage(
  state: StreamState,
  event: SDKMessage,
): void {
  if (event.type === "system") {
    if (event.model?.id) state.cursorMeta.actual_model = event.model.id;
    return;
  }
  if (event.type === "request") {
    state.cursorMeta.request_id = event.request_id;
    return;
  }
  if (event.type === "thinking" && event.thinking_duration_ms != null) {
    state.cursorMeta.thinking_duration_ms = event.thinking_duration_ms;
  }
}

export function applyThinkingCompletedMeta(
  state: StreamState,
  thinkingDurationMs?: number,
): void {
  if (thinkingDurationMs != null) {
    state.cursorMeta.thinking_duration_ms = thinkingDurationMs;
  }
}

function baseChunk(
  state: StreamState,
  delta: ChatCompletionChunk["choices"][0]["delta"],
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: state.completionId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function chunkFromAssistantText(
  state: StreamState,
  text: string,
): ChatCompletionChunk | null {
  if (!text) return null;
  state.text += text;
  return baseChunk(state, { content: text });
}

export function chunkFromReasoningText(
  state: StreamState,
  text: string,
): ChatCompletionChunk | null {
  if (!text) return null;
  state.reasoningText += text;
  return baseChunk(state, { reasoning_content: text, reasoning: text });
}

export function chunkFromToolDelta(
  state: StreamState,
  callId: string,
  name: string,
  input?: unknown,
): ChatCompletionChunk {
  if (input === undefined) {
    if (!state.toolCalls.has(callId)) {
      const index = state.nextToolIndex++;
      state.toolCalls.set(callId, {
        id: callId,
        name,
        arguments: "",
        index,
      });
    }
    const entry = state.toolCalls.get(callId)!;
    return baseChunk(state, {
      tool_calls: [
        {
          index: entry.index,
          id: callId,
          type: "function",
          function: { name, arguments: "" },
        },
      ],
    });
  }

  const fragment =
    typeof input === "string" ? input : JSON.stringify(input ?? {});
  let entry = state.toolCalls.get(callId);
  if (!entry) {
    entry = {
      id: callId,
      name,
      arguments: fragment,
      index: state.nextToolIndex++,
    };
    state.toolCalls.set(callId, entry);
    return baseChunk(state, {
      tool_calls: [
        {
          index: entry.index,
          id: entry.id,
          type: "function",
          function: { name: entry.name, arguments: entry.arguments },
        },
      ],
    });
  }
  entry.arguments += fragment;
  return baseChunk(state, {
    tool_calls: [
      {
        index: entry.index,
        function: { arguments: fragment },
      },
    ],
  });
}

export function finalizeToolCalls(state: StreamState): void {
  for (const entry of state.toolCalls.values()) {
    entry.arguments = normalizeToolArguments(entry.arguments);
  }
}

export function roleChunk(state: StreamState): ChatCompletionChunk {
  return baseChunk(state, { role: "assistant" });
}

// True only for a chunk that carries actual model output (text, reasoning, or a
// tool call). The assistant role bootstrap chunk (`delta: { role: "assistant" }`,
// emitted by the sink before any output) and the terminal finish chunk (empty
// delta) are NOT content-bearing. The SSE heartbeat keys off this so it survives
// the role bootstrap and stops only on the first real delta.
export function isContentBearingChunk(chunk: ChatCompletionChunk): boolean {
  const delta = chunk.choices[0]?.delta;
  if (!delta) return false;
  return (
    delta.content !== undefined ||
    delta.reasoning_content !== undefined ||
    delta.reasoning !== undefined ||
    (delta.tool_calls?.length ?? 0) > 0
  );
}

export function finishChunk(
  state: StreamState,
  preferred: "stop" | "tool_calls" = "stop",
): ChatCompletionChunk {
  finalizeToolCalls(state);
  const finishReason: CompletionFinishReason = resolveFinishReason(
    state,
    preferred,
  );
  const chunk = baseChunk(state, {}, finishReason);
  const withUsage = state.usage ? { ...chunk, usage: state.usage } : chunk;
  const meta = state.cursorMeta.agent_id ? state.cursorMeta : undefined;
  return attachCursorMeta(withUsage, meta);
}

export function* chunksFromSdkMessage(
  event: SDKMessage,
  state: StreamState,
  debugStream = false,
): Generator<ChatCompletionChunk> {
  mergeCursorMetaFromSdkMessage(state, event);

  if (debugStream && event.type === "status") {
    const meta = `${event.status}${event.message ? `: ${event.message}` : ""}`;
    const chunk = chunkFromAssistantText(state, `\n[status] ${meta}\n`);
    if (chunk) yield chunk;
  }
}
