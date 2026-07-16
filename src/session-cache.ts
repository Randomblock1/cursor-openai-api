import type { SDKAgent } from "@cursor/sdk";
import { hashMessageSnapshot } from "./message-fingerprint.js";
import type { ChatMessage } from "./openai.js";

export interface SessionEntry {
  agent: SDKAgent;
  agentId: string;
  modelId: string;
  messageCount: number;
  messagesSnapshotHash: string;
  lastAccess: number;
}

export interface SessionRegistration {
  agent: SDKAgent;
  agentId: string;
  modelId: string;
  messageCount: number;
  messagesSnapshot: ChatMessage[];
  lastAccess: number;
}

export interface SessionSave {
  agent: SDKAgent;
  agentId: string;
  modelId: string;
  messages: ChatMessage[];
  lastAccess: number;
}

export interface SessionCacheLimits {
  ttlMs: number;
  maxEntries: number;
}

export interface MatchedSession {
  key: string;
  entry: SessionEntry;
}

export function messagesPrefixMatches(
  messages: ChatMessage[],
  entry: SessionEntry,
): boolean {
  if (messages.length < entry.messageCount) return false;
  return (
    hashMessageSnapshot(messages.slice(0, entry.messageCount)) ===
    entry.messagesSnapshotHash
  );
}

export function deltaMessagesFromSession(
  messages: ChatMessage[],
  entry: SessionEntry,
): ChatMessage[] {
  return messages.slice(entry.messageCount);
}

export class SessionCache {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionKeysByModel = new Map<string, Set<string>>();

  /**
   * @param onAgentDisposed invoked whenever the cache disposes an agent
   * (eviction, invalidation, replacement) so external state keyed by agent —
   * e.g. a parked client-tool run — can be torn down with it.
   */
  constructor(private readonly onAgentDisposed?: (agentId: string) => void) {}

  private disposeSessionAgent(entry: SessionEntry): void {
    const dispose = entry.agent[Symbol.asyncDispose];
    if (typeof dispose === "function") {
      void dispose.call(entry.agent).catch(() => {});
    }
    this.onAgentDisposed?.(entry.agentId);
  }

  findAutoMatch(
    modelId: string,
    messages: ChatMessage[],
  ): MatchedSession | undefined {
    const keys = this.sessionKeysByModel.get(modelId);
    if (!keys?.size) return undefined;

    let best: MatchedSession | undefined;

    for (const key of keys) {
      const entry = this.sessions.get(key);
      if (!entry) {
        this.untrackSessionKey(key, modelId);
        continue;
      }
      if (messages.length <= entry.messageCount) continue;
      if (!messagesPrefixMatches(messages, entry)) continue;
      if (!best || entry.messageCount > best.entry.messageCount) {
        best = { key, entry };
      }
    }

    if (best) best.entry.lastAccess = Date.now();
    return best;
  }

  matchKeyedSession(
    key: string,
    modelId: string,
    messages: ChatMessage[],
  ): MatchedSession | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined;

    const reusable =
      entry.modelId === modelId && messagesPrefixMatches(messages, entry);
    if (!reusable) {
      this.invalidate(key);
      return undefined;
    }

    entry.lastAccess = Date.now();
    return { key, entry };
  }

  get(key: string): SessionEntry | undefined {
    return this.sessions.get(key);
  }

  saveTurn(key: string, entry: SessionSave): void {
    this.save(key, {
      agent: entry.agent,
      agentId: entry.agentId,
      modelId: entry.modelId,
      messageCount: entry.messages.length,
      messagesSnapshotHash: hashMessageSnapshot(entry.messages),
      lastAccess: entry.lastAccess,
    });
  }

  private save(key: string, entry: SessionEntry): void {
    const previous = this.sessions.get(key);
    if (previous) {
      if (previous.agent !== entry.agent) this.disposeSessionAgent(previous);
      this.untrackSessionKey(key, previous.modelId);
    }

    this.sessions.set(key, entry);
    this.trackSessionKey(key, entry.modelId);
  }

  prune(limits: SessionCacheLimits): void {
    this.pruneExpired(limits.ttlMs);
    this.pruneLeastRecentlyUsed(limits.maxEntries);
  }

  invalidate(key: string): void {
    const entry = this.sessions.get(key);
    if (!entry) return;
    this.disposeSessionAgent(entry);
    this.sessions.delete(key);
    this.untrackSessionKey(key, entry.modelId);
  }

  registerForTests(key: string, entry: SessionRegistration): void {
    this.save(key, {
      agent: entry.agent,
      agentId: entry.agentId,
      modelId: entry.modelId,
      messageCount: entry.messageCount,
      messagesSnapshotHash: hashMessageSnapshot(
        entry.messagesSnapshot.slice(0, entry.messageCount),
      ),
      lastAccess: entry.lastAccess,
    });
  }

  clear(): void {
    for (const entry of this.sessions.values()) {
      this.disposeSessionAgent(entry);
    }
    this.sessions.clear();
    this.sessionKeysByModel.clear();
  }

  private pruneExpired(ttl: number): void {
    const now = Date.now();

    for (const [key, entry] of this.sessions) {
      if (now - entry.lastAccess <= ttl) continue;
      this.disposeSessionAgent(entry);
      this.sessions.delete(key);
      this.untrackSessionKey(key, entry.modelId);
    }
  }

  private pruneLeastRecentlyUsed(max: number): void {
    if (this.sessions.size <= max) return;

    const oldestFirst = [...this.sessions.entries()].sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess,
    );
    while (this.sessions.size > max) {
      const next = oldestFirst.shift();
      if (!next) return;
      const [key, entry] = next;
      this.disposeSessionAgent(entry);
      this.sessions.delete(key);
      this.untrackSessionKey(key, entry.modelId);
    }
  }

  private trackSessionKey(key: string, modelId: string): void {
    let keys = this.sessionKeysByModel.get(modelId);
    if (!keys) {
      keys = new Set();
      this.sessionKeysByModel.set(modelId, keys);
    }
    keys.add(key);
  }

  private untrackSessionKey(key: string, modelId: string): void {
    this.sessionKeysByModel.get(modelId)?.delete(key);
  }
}
