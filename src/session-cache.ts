import type { SDKAgent } from "@cursor/sdk";
import { hashMessageSnapshot } from "./message-fingerprint.js";
import type { ChatMessage } from "./openai.js";

export interface SessionEntry {
  agent: SDKAgent;
  agentId: string;
  modelId: string;
  /** Workspace cwd the agent was created with; "" means unscoped (test entries). */
  cwd: string;
  messageCount: number;
  messagesSnapshotHash: string;
  lastAccess: number;
}

export interface SessionRegistration {
  agent: SDKAgent;
  agentId: string;
  modelId: string;
  cwd?: string;
  messageCount: number;
  messagesSnapshot: ChatMessage[];
  lastAccess: number;
}

export interface SessionSave {
  agent: SDKAgent;
  agentId: string;
  modelId: string;
  cwd: string;
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

/**
 * cwd is part of an agent's identity because `local.cwd` is frozen at
 * `Agent.create` time. Entries without a recorded cwd ("") match anything so
 * test fixtures and legacy entries keep working; a defined cwd only matches an
 * equal request cwd. An `undefined` request cwd disables the filter.
 */
function cwdMatches(entry: SessionEntry, cwd: string | undefined): boolean {
  if (!entry.cwd) return true;
  if (cwd === undefined) return true;
  return entry.cwd === cwd;
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

function disposeSessionAgent(entry: SessionEntry): void {
  const dispose = entry.agent[Symbol.asyncDispose];
  if (typeof dispose === "function") {
    void dispose.call(entry.agent).catch(() => {});
  }
}

export class SessionCache {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionKeysByModel = new Map<string, Set<string>>();

  findAutoMatch(
    modelId: string,
    messages: ChatMessage[],
    cwd?: string,
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
      if (!cwdMatches(entry, cwd)) continue;
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
    cwd?: string,
  ): MatchedSession | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined;

    const reusable =
      entry.modelId === modelId &&
      cwdMatches(entry, cwd) &&
      messagesPrefixMatches(messages, entry);
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
      cwd: entry.cwd,
      messageCount: entry.messages.length,
      messagesSnapshotHash: hashMessageSnapshot(entry.messages),
      lastAccess: entry.lastAccess,
    });
  }

  private save(key: string, entry: SessionEntry): void {
    const previous = this.sessions.get(key);
    if (previous) {
      if (previous.agent !== entry.agent) disposeSessionAgent(previous);
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
    disposeSessionAgent(entry);
    this.sessions.delete(key);
    this.untrackSessionKey(key, entry.modelId);
  }

  registerForTests(key: string, entry: SessionRegistration): void {
    this.save(key, {
      agent: entry.agent,
      agentId: entry.agentId,
      modelId: entry.modelId,
      cwd: entry.cwd ?? "",
      messageCount: entry.messageCount,
      messagesSnapshotHash: hashMessageSnapshot(
        entry.messagesSnapshot.slice(0, entry.messageCount),
      ),
      lastAccess: entry.lastAccess,
    });
  }

  clear(): void {
    for (const entry of this.sessions.values()) {
      disposeSessionAgent(entry);
    }
    this.sessions.clear();
    this.sessionKeysByModel.clear();
  }

  private pruneExpired(ttl: number): void {
    const now = Date.now();

    for (const [key, entry] of this.sessions) {
      if (now - entry.lastAccess <= ttl) continue;
      disposeSessionAgent(entry);
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
      disposeSessionAgent(entry);
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
