import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  test("requires CURSOR_API_KEY", () => {
    expect(() =>
      loadConfig({
        PORT: "8080",
        CURSOR_CWD: "/tmp",
      }),
    ).toThrow(/CURSOR_API_KEY is not set/);
  });

  test("rejects empty CURSOR_API_KEY", () => {
    expect(() =>
      loadConfig({
        CURSOR_API_KEY: "",
        CURSOR_CWD: "/tmp",
      }),
    ).toThrow(/CURSOR_API_KEY is not set/);
  });

  test("parses defaults", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "cursor_test",
      CURSOR_CWD: "/repo",
    });
    expect(config.PORT).toBe(8080);
    expect(config.DEFAULT_MODEL).toBe("composer-2.5");
    expect(config.DEBUG_STREAM).toBe(false);
    expect(config.CURSOR_INCLUDE_THINKING).toBe(true);
    expect(config.CURSOR_ENABLE_SESSIONS).toBe(true);
    expect(config.CURSOR_SESSION_TTL_MS).toBe(30 * 60 * 1000);
    expect(config.CURSOR_SESSION_MAX).toBe(64);
    expect(config.CURSOR_EMIT_TOOL_CALLS).toBe(false);
    expect(config.CURSOR_STREAM_TTFB_TIMEOUT_MS).toBe(900000);
    expect(config.CURSOR_STREAM_IDLE_TIMEOUT_MS).toBe(300000);
    expect(config.CURSOR_STREAM_HEARTBEAT_MS).toBe(15000);
  });

  test("stream stall knobs are overridable and validated", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "cursor_test",
      CURSOR_CWD: "/repo",
      CURSOR_STREAM_TTFB_TIMEOUT_MS: "1000",
      CURSOR_STREAM_IDLE_TIMEOUT_MS: "2000",
      CURSOR_STREAM_HEARTBEAT_MS: "500",
    });
    expect(config.CURSOR_STREAM_TTFB_TIMEOUT_MS).toBe(1000);
    expect(config.CURSOR_STREAM_IDLE_TIMEOUT_MS).toBe(2000);
    expect(config.CURSOR_STREAM_HEARTBEAT_MS).toBe(500);

    expect(() =>
      loadConfig({
        CURSOR_API_KEY: "cursor_test",
        CURSOR_CWD: "/repo",
        CURSOR_STREAM_TTFB_TIMEOUT_MS: "0",
      }),
    ).toThrow();
  });

  test("heartbeat accepts 0 (disable path) but TTFB/idle stay positive", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "cursor_test",
      CURSOR_CWD: "/repo",
      CURSOR_STREAM_HEARTBEAT_MS: "0",
    });
    expect(config.CURSOR_STREAM_HEARTBEAT_MS).toBe(0);

    expect(() =>
      loadConfig({
        CURSOR_API_KEY: "cursor_test",
        CURSOR_CWD: "/repo",
        CURSOR_STREAM_IDLE_TIMEOUT_MS: "0",
      }),
    ).toThrow();
  });

  test("CURSOR_EMIT_TOOL_CALLS can be enabled", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "cursor_test",
      CURSOR_CWD: "/repo",
      CURSOR_EMIT_TOOL_CALLS: "true",
    });
    expect(config.CURSOR_EMIT_TOOL_CALLS).toBe(true);
  });

  test("CURSOR_INCLUDE_THINKING can be disabled", () => {
    const config = loadConfig({
      CURSOR_API_KEY: "cursor_test",
      CURSOR_CWD: "/repo",
      CURSOR_INCLUDE_THINKING: "false",
    });
    expect(config.CURSOR_INCLUDE_THINKING).toBe(false);
  });
});
