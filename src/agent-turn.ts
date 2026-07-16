import {
  Agent,
  type ModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
} from "@cursor/sdk";
import { beforeInterleavedBoundary, flushAssistantText } from "./assistant-output.js";
import { abortBridge, type ClientToolBridge } from "./client-tools/bridge.js";
import {
  ClientToolCoordinator,
  clientToolErrorResult,
  type ClientToolCall,
} from "./client-tools/native.js";
import {
  buildRelaySendOptions,
  InteractionRelay,
  startRunCompletion,
} from "./client-tools/relay.js";
import { planBridgeResume, type BridgeResumePlan } from "./client-tools/results.js";
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
import { chunkFromToolDelta, createStreamState, type StreamState } from "./stream.js";
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
  /** Test/embedder seam: overrides Agent.create for fresh agents. */
  createAgent?: () => Promise<SDKAgent>;
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
    local: {
      cwd: config.CURSOR_CWD,
      settingSources: [],
      ...(config.CURSOR_SANDBOX ? { sandboxOptions: { enabled: true } } : {}),
    },
  };
}

interface ResumableBridge {
  bridge: ClientToolBridge;
  plan: BridgeResumePlan;
}

/**
 * Claim a paused client-tool run for this turn. A bridge that cannot serve
 * the request (dead run, or the delta is not a pure tool-result follow-up)
 * is torn down so the turn falls back to a fresh send that replays the delta
 * messages as prompt text.
 */
async function claimBridge(
  ctx: AgentTurnContext,
  prepared: PreparedChatSession,
): Promise<ResumableBridge | undefined> {
  const bridge = ctx.proxy.toolBridges.take(prepared.agentId);
  if (!bridge) return undefined;

  if (bridge.run.status !== "running") {
    // The run died backend-side while the client was executing its tools; the
    // fallback still answers the follow-up, but the operator should see why
    // the model's native context was lost.
    console.warn(
      `[cursor-openai-api] parked client-tool run ${bridge.run.id} on agent ${bridge.agentId} ` +
        `ended with status "${bridge.run.status}" before the tool results arrived; ` +
        "replaying the follow-up on a fresh send",
    );
  } else {
    const plan = planBridgeResume(
      prepared.deltaMessages,
      bridge.coordinator.pendingIds(),
    );
    // Resuming continues the original run: no send happens, so a model /
    // param change on the follow-up (speed alias, reasoning_effort) cannot
    // apply until the next fresh send on this agent.
    if (plan) return { bridge, plan };
  }

  await abortBridge(bridge);
  return undefined;
}

async function runTurnBody(
  ctx: AgentTurnContext,
  options: AgentTurnOptions,
  prepared: PreparedChatSession,
  resolved: ResolvedModel,
  turnStream: TurnStreamContext,
): Promise<AgentTurnOutcome> {
  const { request, proxy, abortSignal } = ctx;
  const { config, sessions, toolBridges } = proxy;
  const specs = turnStream.clientToolSpecs;

  const state = createStreamState(resolved.clientModel, {
    maxTokens: request.max_tokens,
    agentId: prepared.agentId,
  });
  const cursorMeta = new CursorMetaAccumulator(
    prepared.agentId,
    prepared.sessionKey,
  );
  const sink = createStreamSink(options.stream?.write, state, cursorMeta);
  const onChunk = (chunk: ChatCompletionChunk) => sink.writeDelta(chunk);

  const commitSession = (): string | undefined => {
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
    return committedKey;
  };

  const resumed = await claimBridge(ctx, prepared);

  let run: Run | undefined;
  let relay: InteractionRelay | undefined;
  let coordinator: ClientToolCoordinator | undefined;
  let completion: Promise<RunResult> | undefined;
  let runCompleted = false;
  let runParked = false;
  let unbindAbort: (() => void) | undefined;

  try {
    if (resumed) {
      ({ run, relay, coordinator, completion } = resumed.bridge);
    } else {
      relay = new InteractionRelay();
      coordinator = specs?.length ? new ClientToolCoordinator() : undefined;
      const payload = buildSendPayload(
        prepared.deltaMessages,
        promptExtrasFromRequest(request),
        specs,
      );
      // Per-send `model` is authoritative for tier/params; create-time model on reused
      // agents may differ when switching `*-slow` / `*-fast` mid-session.
      run = await prepared.agent.send(
        payload,
        buildRelaySendOptions(
          relay,
          resolved.sdk,
          coordinator && specs?.length
            ? coordinator.buildCustomTools(specs)
            : undefined,
        ),
      );
      completion = startRunCompletion(run, relay);
    }
    // A rejection may surface while nothing is racing it (e.g. while this
    // segment is still setting up, or after it paused); resurface via the
    // race or the next resume instead of an unhandled rejection.
    completion.catch(() => {});

    unbindAbort = bindRunAbort(run, abortSignal);
    cursorMeta.setRunId(run.id);
    await sink.begin();

    const emitToolCall = async (call: ClientToolCall) => {
      for (const boundary of beforeInterleavedBoundary(
        state,
        turnStream.policy,
      )) {
        if (boundary) await onChunk(boundary);
      }
      await onChunk(
        chunkFromToolDelta(state, call.id, call.name, call.argumentsJson),
      );
    };

    const paused = coordinator
      ? coordinator.armSegment(emitToolCall)
      : new Promise<void>(() => {});
    await relay.attach({ state, stream: turnStream, onChunk });

    if (coordinator) {
      if (resumed) coordinator.provideResults(resumed.plan.results);
      // Surface every call the client has not answered yet: resume
      // stragglers/partial results, and calls that fired before this segment
      // armed (without this, an unanswered pre-arm call would hang the turn —
      // nothing else schedules the pause).
      await coordinator.flushPendingCalls();
      if (coordinator.hasPendingCalls()) coordinator.requestPause();
    }

    const completionOutcome = completion.then((result) => ({
      kind: "completed" as const,
      result,
    }));
    // If the segment pauses first, a later run failure must not become an
    // unhandled rejection — it resurfaces on resume via `completion`.
    completionOutcome.catch(() => {});

    const outcome = await Promise.race([
      completionOutcome,
      paused.then(() => ({ kind: "paused" as const })),
    ]);

    await relay.detach();
    coordinator?.detachSegment();

    if (outcome.kind === "completed") {
      runCompleted = true;
      coordinator?.settleAll(
        clientToolErrorResult("The run ended before this tool call was answered."),
      );

      if (outcome.result.status === "error") {
        // RunResult carries the failure in `error`; `result` is success text.
        throw new ProxyError(
          outcome.result.error?.message ??
            outcome.result.result ??
            "Agent run failed",
          502,
          "server_error",
          outcome.result.error?.code ?? "agent_run_error",
        );
      }
      if (outcome.result.status === "cancelled") {
        throw new ProxyError("Agent run was cancelled", 499, "server_error");
      }

      commitSession();

      await sink.complete();

      return {
        state,
        meta: cursorMeta,
        prepared,
        finalText: outcome.result.result,
      };
    }

    // Paused on client tool calls: finish this response with
    // `finish_reason: "tool_calls"` (state.toolCalls is non-empty) and keep
    // the run blocked until the client's follow-up delivers the results.
    const flushed = flushAssistantText(state, turnStream.policy);
    if (flushed) await onChunk(flushed);

    const committedKey = commitSession();

    const canPark = Boolean(coordinator && committedKey && prepared.retainAgent);
    if (coordinator && canPark) {
      // Park in the same synchronous step as commitSession: agent disposal
      // driven by another request's prepare runs outside the turn queue, and
      // its onAgentDisposed teardown only finds the bridge if no await
      // separates the commit from the registration. If the final write below
      // fails, the catch reclaims the bridge and tears the run down.
      toolBridges.register(
        {
          agentId: prepared.agentId,
          run,
          relay,
          coordinator,
          completion,
        },
        config.CURSOR_TOOL_RESULT_TIMEOUT_MS,
      );
      runParked = true;
    } else if (coordinator) {
      // No session to route the follow-up back to this run (sessions
      // disabled): unblock the SDK and cancel; the follow-up request replays
      // the tool results as prompt text on a fresh run.
      coordinator.settleAll(
        clientToolErrorResult(
          "Tool results are delivered on a follow-up request; this run will not receive them.",
        ),
      );
    }

    await sink.complete();

    return { state, meta: cursorMeta, prepared };
  } catch (err) {
    if (runParked) {
      // The final write failed after parking: reclaim the bridge so the
      // teardown below owns the run again (a disposal racing this may
      // already have taken and aborted it — then there is nothing to take).
      toolBridges.take(prepared.agentId);
      runParked = false;
    }
    await relay?.detach().catch(() => {});
    coordinator?.detachSegment();
    coordinator?.settleAll(
      clientToolErrorResult("The agent turn failed before this tool call was answered."),
    );
    cursorMeta.mergeFromStream(state);
    await sink.fail();
    throw mapCursorError(err);
  } finally {
    unbindAbort?.();
    if (!runParked) {
      await cancelRunIfIncomplete(run, runCompleted);
    }
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
    ctx.createAgent ?? (() => Agent.create(agentOptions)),
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
