import { Agent, type SDKAgent } from "@cursor/sdk";
import type { AppConfig } from "./config.js";
import type { ChatCompletionRequest, ChatMessage } from "./openai.js";
import {
  deltaMessagesFromSession,
  messagesPrefixMatches,
  SessionCache,
  type MatchedSession,
  type SessionEntry,
  type SessionRegistration,
} from "./session-cache.js";
import {
  resolveResumeAgentId,
  resolveSessionKey,
  type SessionRequestHeaders,
} from "./session-keys.js";
import { AgentTurnQueue } from "./turn-queue.js";

export interface PreparedChatSession {
  agent: SDKAgent;
  agentId: string;
  deltaMessages: ChatMessage[];
  sessionKey: string | undefined;
  retainAgent: boolean;
}

export interface SessionStoreOptions {
  /** Fires when the cache disposes an agent (eviction/invalidation/replacement). */
  onAgentDisposed?: (agentId: string) => void;
}

export class SessionStore {
  private readonly cache: SessionCache;
  private readonly turnQueue = new AgentTurnQueue();

  constructor(options?: SessionStoreOptions) {
    this.cache = new SessionCache(options?.onAgentDisposed);
  }

  findMatchingSessionEntry(
    modelId: string,
    messages: ChatMessage[],
  ): { key: string; entry: SessionEntry } | undefined {
    return this.cache.findAutoMatch(modelId, messages);
  }

  async withAgentTurn<T>(
    agentId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.turnQueue.run(agentId, fn);
  }

  async prepareChatSession(
    createAgent: () => Promise<SDKAgent>,
    request: ChatCompletionRequest,
    sdkModelId: string,
    config: AppConfig,
    headers?: SessionRequestHeaders,
    createAgentOptions?: Parameters<typeof Agent.create>[0],
  ): Promise<PreparedChatSession> {
    if (!config.CURSOR_ENABLE_SESSIONS) {
      const agent = await createAgent();
      return {
        agent,
        agentId: agent.agentId,
        deltaMessages: request.messages,
        sessionKey: undefined,
        retainAgent: false,
      };
    }

    this.pruneCache(config);

    const sessionKey = resolveSessionKey(request, headers);

    if (sessionKey) {
      const keyed = this.tryKeyedSession(sessionKey, request, sdkModelId);
      if (keyed) return keyed;
    }

    if (config.CURSOR_AUTO_SESSION !== false) {
      const matched = this.tryAutoMatchedSession(sdkModelId, request.messages);
      if (matched) return matched;
    }

    const resumeAgentId = resolveResumeAgentId(request);
    if (resumeAgentId && createAgentOptions) {
      const resumed = await this.tryResumeAgent(
        resumeAgentId,
        createAgentOptions,
        request,
        sessionKey,
      );
      if (resumed) return resumed;
    }

    const agent = await createAgent();
    const autoSession =
      config.CURSOR_ENABLE_SESSIONS && config.CURSOR_AUTO_SESSION !== false;
    return {
      agent,
      agentId: agent.agentId,
      deltaMessages: request.messages,
      sessionKey,
      retainAgent: Boolean(sessionKey) || autoSession,
    };
  }

  commitChatSession(
    prepared: PreparedChatSession,
    request: ChatCompletionRequest,
    modelId: string,
    config: AppConfig,
  ): string | undefined {
    if (!config.CURSOR_ENABLE_SESSIONS || !prepared.retainAgent) {
      return prepared.sessionKey;
    }

    const key =
      prepared.sessionKey ??
      (config.CURSOR_AUTO_SESSION !== false
        ? `auto:${crypto.randomUUID()}`
        : undefined);
    if (!key) return undefined;

    this.cache.saveTurn(key, {
      agent: prepared.agent,
      agentId: prepared.agentId,
      modelId,
      messages: request.messages,
      lastAccess: Date.now(),
    });
    this.pruneCache(config);
    return key;
  }

  async releaseChatAgent(prepared: PreparedChatSession): Promise<void> {
    if (prepared.retainAgent) return;
    await prepared.agent[Symbol.asyncDispose]();
  }

  registerTestSession(key: string, entry: SessionRegistration): void {
    this.cache.registerForTests(key, entry);
  }

  clearForTests(): void {
    this.cache.clear();
    this.turnQueue.clear();
  }

  private tryKeyedSession(
    sessionKey: string,
    request: ChatCompletionRequest,
    modelId: string,
  ): PreparedChatSession | undefined {
    const matched = this.cache.matchKeyedSession(
      sessionKey,
      modelId,
      request.messages,
    );
    return matched
      ? this.prepareFromMatchedSession(matched, request.messages)
      : undefined;
  }

  private tryAutoMatchedSession(
    modelId: string,
    messages: ChatMessage[],
  ): PreparedChatSession | undefined {
    const matched = this.findMatchingSessionEntry(modelId, messages);
    if (!matched) return undefined;
    return this.prepareFromMatchedSession(matched, messages);
  }

  private async tryResumeAgent(
    resumeAgentId: string,
    createAgentOptions: Parameters<typeof Agent.create>[0],
    request: ChatCompletionRequest,
    sessionKey: string | undefined,
  ): Promise<PreparedChatSession | undefined> {
    try {
      const agent = await Agent.resume(resumeAgentId, createAgentOptions);
      const entry = sessionKey ? this.cache.get(sessionKey) : undefined;
      const deltaMessages =
        entry &&
        entry.agentId === agent.agentId &&
        messagesPrefixMatches(request.messages, entry)
          ? deltaMessagesFromSession(request.messages, entry)
          : request.messages;
      return {
        agent,
        agentId: agent.agentId,
        deltaMessages,
        sessionKey,
        retainAgent: Boolean(sessionKey),
      };
    } catch (err) {
      console.warn(
        `[cursor-openai-api] Agent.resume(${resumeAgentId}) failed; creating a new agent.`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  private prepareFromMatchedSession(
    matched: MatchedSession,
    messages: ChatMessage[],
  ): PreparedChatSession {
    return {
      agent: matched.entry.agent,
      agentId: matched.entry.agentId,
      deltaMessages: deltaMessagesFromSession(messages, matched.entry),
      sessionKey: matched.key,
      retainAgent: true,
    };
  }

  private pruneCache(config: AppConfig): void {
    this.cache.prune({
      ttlMs: config.CURSOR_SESSION_TTL_MS,
      maxEntries: config.CURSOR_SESSION_MAX,
    });
  }
}
