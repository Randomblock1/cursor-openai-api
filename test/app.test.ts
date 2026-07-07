import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const testConfig: AppConfig = {
  CURSOR_API_KEY: "cursor_test_key",
  CURSOR_CWD: process.cwd(),
  PORT: 8080,
  HOST: "127.0.0.1",
  DEFAULT_MODEL: "composer-2",
  AUTH_KEY: "test-secret",
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

describe("createApp", () => {
  const app = createApp(testConfig);

  test("GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("rejects missing auth", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toContain("Invalid API key");
  });

  test("rejects invalid chat payload", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("rejects invalid responses payload", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

});
