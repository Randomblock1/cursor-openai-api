import { afterAll, describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import type { SDKAgent } from "@cursor/sdk";
import { SessionStore } from "../src/session-store.js";

const config: AppConfig = {
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
  CURSOR_SANDBOX: false,
};

const store = new SessionStore();

describe("keyed session retry", () => {
  test("reuses agent when message count equals cached count after failed turn", async () => {
    const agent = { agentId: "agent-retry", [Symbol.asyncDispose]: async () => {} } as SDKAgent;
    store.registerTestSession("sess-retry", {
      agent,
      agentId: "agent-retry",
      modelId: "composer-2",
      messageCount: 2,
      messagesSnapshot: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      lastAccess: Date.now(),
    });

    const request = {
      messages: [
        { role: "user" as const, content: "Hi" },
        { role: "assistant" as const, content: "Hello" },
      ],
    };

    const prepared = await store.prepareChatSession(
      async () => ({ agentId: "new" }) as SDKAgent,
      request,
      "composer-2",
      config,
      { "x-session-id": "sess-retry" },
    );

    expect(prepared.agent).toBe(agent);
    expect(prepared.deltaMessages).toEqual([]);
  });
});

afterAll(() => {
  store.clearForTests();
});
