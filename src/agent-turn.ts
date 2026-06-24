import { Agent, type ModelSelection, type Run } from "@cursor/sdk";
import { buildSendOptions, pumpSdkMessageStream } from "./agent-stream.js";
import { CursorMetaAccumulator } from "./cursor-meta.js";
import { cwdIdentity, resolveWorkspaceCwd } from "./workspace.js";
import { ProxyError, mapCursorError } from "./errors.js";
import { resolveModel, type ResolvedModel } from "./model.js";
import { resolveTurnStreamContext, type TurnStreamContext } from "./turn-stream.js";
import {
  buildSendPayload,
  promptExtrasFromRequest,
} from "./messages.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "./openai.js";
import type { ProxyContext } from "./proxy-context.js";
import { bindRunAbort, cancelRunIfIncomplete } from "./run-lifecycle.js";
import type { PreparedChatSession } from "./session-store.js";
import type { SessionRequestHeaders } from "./session-keys.js";
import { createStreamState, type StreamState } from "./stream.js";
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
  cwd: string | string[],
) {
  return {
    apiKey: config.CURSOR_API_KEY,
    model: sdkModel,
    local: { cwd, settingSources: [] },
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
      buildSendOptions(state, turnStream, resolved.sdk, onChunk),
    );
    unbindAbort = bindRunAbort(run, abortSignal);
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
  const cwd = resolveWorkspaceCwd(request, headers, config);
  const agentOptions = createAgentOptions(config, resolved.sdk, cwd);

  // The SDK agent is created with the full (possibly multi-root) cwd, but the
  // session cache keys by a single canonical string so reuse keeps matching.
  const prepared = await sessions.prepareChatSession(
    () => Agent.create(agentOptions),
    request,
    resolved.sdk.id,
    config,
    headers,
    agentOptions,
    cwdIdentity(cwd),
  );

  return sessions.withAgentTurn(prepared.agentId, () =>
    runTurnBody(ctx, options, prepared, resolved, turnStream),
  );
}
