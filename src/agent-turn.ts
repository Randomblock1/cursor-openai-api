import { Agent, type ModelSelection, type Run } from "@cursor/sdk";
import {
  buildSendOptions,
  pumpSdkMessageStream,
  startStreamWatchdog,
  type StreamActivity,
} from "./agent-stream.js";
import { CursorMetaAccumulator } from "./cursor-meta.js";
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

  let run: Run | undefined;
  let runCompleted = false;
  let unbindAbort: (() => void) | undefined;
  const sink = createStreamSink(options.stream?.write, state, cursorMeta);
  // Track liveness off the emitted deltas (what the consumer actually sees) so
  // the stall watchdog measures TTFB and inter-delta idle, not raw SDK events.
  const activity: StreamActivity = {
    firstDeltaAt: undefined,
    lastActivityAt: Date.now(),
  };
  const onChunk = (chunk: ChatCompletionChunk) => {
    const now = Date.now();
    activity.lastActivityAt = now;
    if (activity.firstDeltaAt === undefined) activity.firstDeltaAt = now;
    return sink.writeDelta(chunk);
  };

  try {
    // Per-send `model` is authoritative for tier/params; create-time model on reused
    // agents may differ when switching `*-slow` / `*-fast` mid-session.
    const sendStartedAt = Date.now();
    run = await prepared.agent.send(
      payload,
      buildSendOptions(state, turnStream, resolved.sdk, onChunk),
    );
    unbindAbort = bindRunAbort(run, abortSignal);
    cursorMeta.setRunId(run.id);
    await sink.begin();

    // Bound the streaming window: cancel + 504 if the run never produces a first
    // delta (TTFB) or goes silent mid-stream (idle), instead of hanging forever.
    const watchdog = startStreamWatchdog(run, activity, {
      ttfbTimeoutMs: config.CURSOR_STREAM_TTFB_TIMEOUT_MS,
      idleTimeoutMs: config.CURSOR_STREAM_IDLE_TIMEOUT_MS,
      sendStartedAt,
    });
    try {
      const pump = pumpSdkMessageStream(
        run,
        state,
        turnStream.policy.debugStream,
        onChunk,
      );
      // The race's loser keeps running; ensure its rejection can't go unhandled.
      pump.catch(() => {});
      await Promise.race([pump, watchdog.expired]);
    } finally {
      // Once the stream has drained, idle/TTFB no longer apply — only the
      // streaming window is guarded.
      watchdog.stop();
    }

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
