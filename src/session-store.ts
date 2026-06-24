import path from "node:path";
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
  cwd: string;
  retainAgent: boolean;
}

export class SessionStore {
  private readonly cache = new SessionCache();
  private readonly turnQueue = new AgentTurnQueue();

  findMatchingSessionEntry(
    modelId: string,
    messages: ChatMessage[],
    cwd?: string,
  ): { key: string; entry: SessionEntry } | undefined {
    return this.cache.findAutoMatch(modelId, messages, cwd);
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
    cwd?: string,
  ): Promise<PreparedChatSession> {
    // Normalize the fallback the same way resolveWorkspaceCwd() normalizes
    // overrides. cwd is part of an agent's identity (see cwdMatches in
    // session-cache.ts), so a raw CURSOR_CWD here would not string-equal the
    // path.resolve()d cwd a later turn supplies for the same workspace.
    const sessionCwd = cwd ?? path.resolve(config.CURSOR_CWD);

    if (!config.CURSOR_ENABLE_SESSIONS) {
      const agent = await createAgent();
      return {
        agent,
        agentId: agent.agentId,
        deltaMessages: request.messages,
        sessionKey: undefined,
        cwd: sessionCwd,
        retainAgent: false,
      };
    }

    this.pruneCache(config);

    const sessionKey = resolveSessionKey(request, headers);

    if (sessionKey) {
      const keyed = this.tryKeyedSession(
        sessionKey,
        request,
        sdkModelId,
        sessionCwd,
      );
      if (keyed) return keyed;
    }

    if (config.CURSOR_AUTO_SESSION !== false) {
      const matched = this.tryAutoMatchedSession(
        sdkModelId,
        request.messages,
        sessionCwd,
      );
      if (matched) return matched;
    }

    const resumeAgentId = resolveResumeAgentId(request);
    if (resumeAgentId && createAgentOptions) {
      const resumed = await this.tryResumeAgent(
        resumeAgentId,
        createAgentOptions,
        request,
        sessionKey,
        sessionCwd,
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
      cwd: sessionCwd,
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
      cwd: prepared.cwd,
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
    cwd: string,
  ): PreparedChatSession | undefined {
    const matched = this.cache.matchKeyedSession(
      sessionKey,
      modelId,
      request.messages,
      cwd,
    );
    return matched
      ? this.prepareFromMatchedSession(matched, request.messages, cwd)
      : undefined;
  }

  private tryAutoMatchedSession(
    modelId: string,
    messages: ChatMessage[],
    cwd: string,
  ): PreparedChatSession | undefined {
    const matched = this.findMatchingSessionEntry(modelId, messages, cwd);
    if (!matched) return undefined;
    return this.prepareFromMatchedSession(matched, messages, cwd);
  }

  private async tryResumeAgent(
    resumeAgentId: string,
    createAgentOptions: Parameters<typeof Agent.create>[0],
    request: ChatCompletionRequest,
    sessionKey: string | undefined,
    cwd: string,
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
        cwd,
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
    cwd: string,
  ): PreparedChatSession {
    return {
      agent: matched.entry.agent,
      agentId: matched.entry.agentId,
      deltaMessages: deltaMessagesFromSession(messages, matched.entry),
      sessionKey: matched.key,
      cwd,
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
