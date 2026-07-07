import { afterAll, describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import type { SDKAgent } from "@cursor/sdk";
import { SessionStore } from "../src/session-store.js";
import {
  resolveSessionKey,
} from "../src/session-keys.js";

const baseConfig: AppConfig = {
  CURSOR_API_KEY: "key",
  CURSOR_CWD: "/tmp",
  PORT: 8080,
  HOST: "0.0.0.0",
  DEFAULT_MODEL: "composer-2.5",
  DEBUG_STREAM: false,
  CURSOR_INCLUDE_THINKING: true,
  CURSOR_EMIT_TOOL_CALLS: false,
  CURSOR_ENABLE_SESSIONS: true,
  CURSOR_AUTO_SESSION: true,
  CURSOR_SESSION_TTL_MS: 60_000,
  CURSOR_SESSION_MAX: 8,
  CURSOR_TOOL_RESULT_TIMEOUT_MS: 60_000,
};

const store = new SessionStore();

describe("resolveSessionKey", () => {
  test("prefers x-session-id header", () => {
    const key = resolveSessionKey(
      { messages: [{ role: "user", content: "hi" }] },
      { "x-session-id": "sess-abc" },
    );
    expect(key).toBe("sess-abc");
  });

  test("reads metadata.session_id", () => {
    const key = resolveSessionKey({
      messages: [{ role: "user", content: "hi" }],
      metadata: { session_id: "meta-1" },
    });
    expect(key).toBe("meta-1");
  });

  test("does not use OpenAI user field as session id", () => {
    const key = resolveSessionKey({
      messages: [{ role: "user", content: "hi" }],
      user: "alice",
    });
    expect(key).toBeUndefined();
  });

  test("returns undefined when no session id", () => {
    const key = resolveSessionKey({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(key).toBeUndefined();
  });
});

describe("findMatchingSessionEntry", () => {
  test("matches on base sdk model id (not speed alias suffix)", () => {
    const agent = { agentId: "agent-alias" } as SDKAgent;
    store.registerTestSession("auto:alias", {
      agent,
      agentId: "agent-alias",
      modelId: "composer-2.5",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "Hi" }],
      lastAccess: Date.now(),
    });

    const match = store.findMatchingSessionEntry("composer-2.5", [
      { role: "user", content: "Hi" },
      { role: "user", content: "Again" },
    ]);
    expect(match?.key).toBe("auto:alias");
  });

  test("matches a longer message list with the same prefix", () => {
    const agent = { agentId: "agent-1" } as SDKAgent;
    store.registerTestSession("auto:1", {
      agent,
      agentId: "agent-1",
      modelId: "composer-2",
      messageCount: 2,
      messagesSnapshot: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      lastAccess: Date.now(),
    });

    const match = store.findMatchingSessionEntry("composer-2", [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Follow up" },
    ]);
    expect(match?.key).toBe("auto:1");
    expect(match?.entry.agentId).toBe("agent-1");
  });
});

describe("session speed alias reuse", () => {
  test("auto-session matches base sdk id when follow-up uses slow alias", async () => {
    const agent = { agentId: "agent-speed" } as SDKAgent;
    store.registerTestSession("auto:speed", {
      agent,
      agentId: "agent-speed",
      modelId: "composer-2.5",
      messageCount: 2,
      messagesSnapshot: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      lastAccess: Date.now(),
    });

    const followUpMessages = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Hello" },
      { role: "user" as const, content: "Follow up" },
    ];

    const match = store.findMatchingSessionEntry("composer-2.5", followUpMessages);
    expect(match?.entry.agentId).toBe("agent-speed");

    const prepared = await store.prepareChatSession(
      async () => {
        throw new Error("should reuse cached agent, not create");
      },
      { messages: followUpMessages, model: "composer-2.5-slow" },
      "composer-2.5",
      baseConfig,
    );

    expect(prepared.agentId).toBe("agent-speed");
    expect(prepared.deltaMessages).toEqual([{ role: "user", content: "Follow up" }]);
  });

  test("keyed session reuses agent when follow-up uses slow alias", async () => {
    const agent = { agentId: "agent-keyed-speed" } as SDKAgent;
    store.registerTestSession("sess-speed", {
      agent,
      agentId: "agent-keyed-speed",
      modelId: "composer-2.5",
      messageCount: 1,
      messagesSnapshot: [{ role: "user", content: "Hi" }],
      lastAccess: Date.now(),
    });

    const followUpMessages = [
      { role: "user" as const, content: "Hi" },
      { role: "user" as const, content: "Follow up" },
    ];

    const prepared = await store.prepareChatSession(
      async () => {
        throw new Error("should reuse keyed session, not create");
      },
      {
        messages: followUpMessages,
        model: "composer-2.5-slow",
        metadata: { session_id: "sess-speed" },
      },
      "composer-2.5",
      baseConfig,
      { "x-session-id": "sess-speed" },
    );

    expect(prepared.agentId).toBe("agent-keyed-speed");
    expect(prepared.deltaMessages).toEqual([{ role: "user", content: "Follow up" }]);
  });
});

describe("session config", () => {
  test("baseConfig enables sessions by default", () => {
    expect(baseConfig.CURSOR_ENABLE_SESSIONS).toBe(true);
    expect(baseConfig.CURSOR_AUTO_SESSION).toBe(true);
  });
});

afterAll(() => {
  store.clearForTests();
});
