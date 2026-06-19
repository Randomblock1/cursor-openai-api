import { Agent, type ModelSelection, type Run } from "@cursor/sdk";
import { buildSendOptions, pumpSdkMessageStream } from "./agent-stream.js";
import { CursorMetaAccumulator } from "./cursor-meta.js";
import { ProxyError, mapCursorError } from "./errors.js";
import { resolveModel, type ResolvedModel } from "./model.js";
import { resolveTurnStreamContext, type TurnStreamContext } from "./turn-stream.js";
import {
  buildSendPayload,
  promptExtrasFromRequest,
} from "./messages.js";
import { resolveToolTier } from "./client-tools/catalog.js";
import {
  ClientToolCaptureSink,
  buildClientToolCustomTools,
} from "./client-tools/custom-tools-bridge.js";
import { toOpenAiToolCalls } from "./client-tools/openai-map.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "./openai.js";
import type { ProxyContext } from "./proxy-context.js";
import { bindRunAbort, cancelRunIfIncomplete } from "./run-lifecycle.js";
import type { PreparedChatSession } from "./session-store.js";
import type { SessionRequestHeaders } from "./session-keys.js";
import {
  chunkFromToolDelta,
  createStreamState,
  type StreamState,
} from "./stream.js";
import {
  type ChatChunkWriter,
  createStreamSink,
} from "./stream-sink.js";

export type { ChatChunkWriter } from "./stream-sink.js";

interface AgentTurnContext {
  proxy: ProxyContext;
  request: ChatCompletionRequest;
  headers?: SessionRequestHeaders;
  abortSignal?: AbortSignal;
}

export interface AgentTurnOptions {
  stream?: {
    write: ChatChunkWriter;
  };
}

export interface AgentTurnOutcome {
  state: StreamState;
  meta: CursorMetaAccumulator;
  prepared: PreparedChatSession;
  finalText?: string;
}

function createAgentOptions(
  config: ProxyContext["config"],
  sdkModel: ModelSelection,
) {
  return {
    apiKey: config.CURSOR_API_KEY,
    model: sdkModel,
    local: { cwd: config.CURSOR_CWD, settingSources: [] },
  };
}

async function runTurnBody(
  ctx: AgentTurnContext,
  options: AgentTurnOptions,
  prepared: PreparedChatSession,
  resolved: ResolvedModel,
  turnStream: TurnStreamContext,
): Promise<AgentTurnOutcome> {
  const { request, proxy, abortSignal } = ctx;
  const { config, sessions } = proxy;
  const extras = promptExtrasFromRequest(request);

  const state = createStreamState(resolved.clientModel, {
    maxTokens: request.max_tokens,
    agentId: prepared.agentId,
  });
  const cursorMeta = new CursorMetaAccumulator(
    prepared.agentId,
    prepared.sessionKey,
  );

  const payload = buildSendPayload(
    prepared.deltaMessages,
    extras,
    turnStream.clientToolSpecs,
  );

  // Client-tool bridge: register the request's client tools as in-process SDK
  // customTools so a native invocation of a caller tool is captured (and
  // converted to an OpenAI tool_call) instead of failing with "Tool not found".
  // This is the sole client-tool channel; non-client turns skip it entirely.
  // Tiering is applied to the customTool schemas (the prompt no longer carries a
  // tool inventory), so it MUST live here to stay token-neutral.
  const clientToolSpecs = turnStream.clientToolSpecs;
  const captureSink =
    turnStream.policy.clientToolLoop && clientToolSpecs?.length
      ? new ClientToolCaptureSink()
      : undefined;
  const customTools =
    captureSink && clientToolSpecs
      ? buildClientToolCustomTools(
          clientToolSpecs,
          captureSink,
          resolveToolTier(config),
        )
      : undefined;

  let run: Run | undefined;
  let runCompleted = false;
  let unbindAbort: (() => void) | undefined;
  const sink = createStreamSink(options.stream?.write, state, cursorMeta);
  const onChunk = (chunk: ChatCompletionChunk) => sink.writeDelta(chunk);

  try {
    // Per-send `model` is authoritative for tier/params; create-time model on reused
    // agents may differ when switching `*-slow` / `*-fast` mid-session.
    run = await prepared.agent.send(
      payload,
      buildSendOptions(state, turnStream, resolved.sdk, onChunk, customTools),
    );
    unbindAbort = bindRunAbort(run, abortSignal);
    // Cancel the run once a client tool is captured so the turn ends with the
    // tool call(s) for the caller to execute, rather than the SDK feeding a
    // placeholder result back to the model and continuing. The sink DEBOUNCES
    // this cancel (deferred to the next macrotask, re-armed on each capture) so
    // that when the model emits N parallel tool calls in one turn, all N land in
    // `execute` before the run is cancelled — cancelling on the first capture
    // would abort the stream and drop calls 2..N. Cancel is fire-and-forget.
    if (captureSink) {
      const activeRun = run;
      captureSink.bindCancel(() => {
        if (activeRun.supports("cancel")) {
          void activeRun.cancel().catch(() => {});
        }
      });
    }
    cursorMeta.setRunId(run.id);
    await sink.begin();

    await pumpSdkMessageStream(
      run,
      state,
      turnStream.policy.debugStream,
      onChunk,
    );

    const result = await run.wait();
    runCompleted = true;

    // A bridged turn deliberately cancels its own run, so a "cancelled" (or even
    // "error") status with captures in hand is the success path, not a failure.
    const bridged = captureSink?.hasCaptured() ?? false;
    if (!bridged) {
      if (result.status === "error") {
        throw new ProxyError(
          result.result ?? "Agent run failed",
          502,
          "server_error",
          "agent_run_error",
        );
      }
      if (result.status === "cancelled") {
        throw new ProxyError("Agent run was cancelled", 499, "server_error");
      }
    }

    if (bridged && captureSink && clientToolSpecs) {
      // Convert the captured native calls into OpenAI tool_calls. Emitting via
      // chunkFromToolDelta both streams the delta (when streaming) and populates
      // state.toolCalls, so finish_reason resolves to "tool_calls" on both paths.
      const mapped = toOpenAiToolCalls({
        toolCalls: [...captureSink.captured],
        tools: clientToolSpecs,
        responseId: state.completionId,
        startIndex: state.toolCalls.size,
      });
      for (const call of mapped) {
        await onChunk(
          chunkFromToolDelta(
            state,
            call.id,
            call.function.name,
            call.function.arguments,
          ),
        );
      }
    }

    cursorMeta.mergeFromStream(state);
    const committedKey = sessions.commitChatSession(
      prepared,
      request,
      resolved.sdk.id,
      config,
    );
    if (committedKey) {
      cursorMeta.setSessionId(committedKey);
      prepared.sessionKey = committedKey;
    }

    await sink.complete();

    return {
      state,
      meta: cursorMeta,
      prepared,
      finalText: result.result,
    };
  } catch (err) {
    cursorMeta.mergeFromStream(state);
    await sink.fail();
    throw mapCursorError(err);
  } finally {
    unbindAbort?.();
    await cancelRunIfIncomplete(run, runCompleted);
    await sessions.releaseChatAgent(prepared);
  }
}

export async function executeAgentTurn(
  ctx: AgentTurnContext,
  options: AgentTurnOptions = {},
): Promise<AgentTurnOutcome> {
  const { request, proxy, headers } = ctx;
  const { config, sessions } = proxy;
  const turnStream = resolveTurnStreamContext(request, config);
  const resolved = await resolveModel(
    request,
    config,
    turnStream.policy.includeThinking,
  );
  const agentOptions = createAgentOptions(config, resolved.sdk);

  const prepared = await sessions.prepareChatSession(
    () => Agent.create(agentOptions),
    request,
    resolved.sdk.id,
    config,
    headers,
    agentOptions,
  );

  return sessions.withAgentTurn(prepared.agentId, () =>
    runTurnBody(ctx, options, prepared, resolved, turnStream),
  );
}
