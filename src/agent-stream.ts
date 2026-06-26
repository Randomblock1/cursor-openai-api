import type {
  InteractionUpdate,
  ModelSelection,
  Run,
  SDKCustomTool,
} from "@cursor/sdk";
import { applyInteractionUpdate } from "./interaction-delta.js";
import type { ChatCompletionChunk } from "./openai.js";
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
  // Client-tool bridge: when present, register the request's client tools as
  // in-process SDK tools so native invocations are captured instead of failing
  // with "Tool not found" (see client-tools/custom-tools-bridge.ts).
  customTools?: Record<string, SDKCustomTool>,
) {
  return {
    model: sdkModel,
    onDelta: async ({ update }: { update: InteractionUpdate }) => {
      await applyInteractionUpdate(state, update, stream, writeChunk);
      captureTurnUsage(state, update);
    },
    ...(customTools ? { local: { customTools } } : {}),
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
