import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.js";
import type { ChatCompletionRequest } from "../src/openai.js";
import { resolveTurnPolicy } from "../src/turn-policy.js";

const baseConfig = {
  CURSOR_API_KEY: "k",
  CURSOR_CWD: "/tmp",
  PORT: 8080,
  HOST: "0.0.0.0",
  DEFAULT_MODEL: "composer-2.5",
  CURSOR_INCLUDE_THINKING: true,
  CURSOR_EMIT_TOOL_CALLS: true,
  CURSOR_ASSISTANT_TEXT_MODE: "live" as const,
  CURSOR_ENABLE_SESSIONS: true,
  CURSOR_AUTO_SESSION: true,
  CURSOR_SESSION_TTL_MS: 1,
  CURSOR_SESSION_MAX: 1,
  CURSOR_TOOL_RESULT_TIMEOUT_MS: 60_000,
  CURSOR_SANDBOX: false,
} satisfies AppConfig;

describe("resolveTurnPolicy", () => {
  test("client tool loop keeps assistant text mode from config", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "echo", parameters: { type: "object", properties: {} } },
        },
      ],
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.clientToolLoop).toBe(true);
    expect(policy.emitCursorTools).toBe(false);
    expect(policy.assistantTextMode).toBe("live");
  });

  test("request override wins over env", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      cursor_assistant_text_mode: "preamble-as-reasoning",
    } satisfies ChatCompletionRequest;

    expect(resolveTurnPolicy(request, baseConfig).assistantTextMode).toBe(
      "preamble-as-reasoning",
    );
  });

  test("tool_choice none disables client tool loop", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "echo" } }],
      tool_choice: "none",
    } satisfies ChatCompletionRequest;

    expect(resolveTurnPolicy(request, baseConfig).clientToolLoop).toBe(false);
  });

  test("emitCursorTools follows config when no client tools", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
    } satisfies ChatCompletionRequest;

    const policy = resolveTurnPolicy(request, baseConfig);
    expect(policy.emitCursorTools).toBe(true);
    expect(policy.clientToolLoop).toBe(false);
  });
});
