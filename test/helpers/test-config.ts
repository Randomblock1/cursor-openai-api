import type { AppConfig } from "../../src/config.js";

/** Shared proxy config for model / session tests (thinking off unless overridden). */
export function testProxyConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    CURSOR_API_KEY: "test-key",
    CURSOR_CWD: process.cwd(),
    PORT: 8080,
    HOST: "127.0.0.1",
    DEFAULT_MODEL: "composer-2.5",
    AUTH_KEY: undefined,
    DEBUG_STREAM: false,
    CURSOR_INCLUDE_THINKING: false,
    CURSOR_EMIT_TOOL_CALLS: false,
    CURSOR_ENABLE_SESSIONS: true,
    CURSOR_AUTO_SESSION: true,
    CURSOR_SESSION_TTL_MS: 60_000,
    CURSOR_SESSION_MAX: 8,
    CURSOR_TOOL_RESULT_TIMEOUT_MS: 60_000,
    ...overrides,
  };
}

export const composerCatalogEntry = {
  id: "composer-2.5",
  displayName: "Composer 2.5",
  parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
  variants: [
    {
      displayName: "Composer 2.5",
      isDefault: true,
      params: [{ id: "fast", value: "true" }],
    },
  ],
};

export const noFastCatalogEntry = {
  id: "legacy-model",
  displayName: "Legacy",
  parameters: [{ id: "max_mode", values: [{ value: "on" }] }],
};
