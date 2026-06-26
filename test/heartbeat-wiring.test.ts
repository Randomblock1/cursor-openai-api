import { describe, expect, test } from "bun:test";
import type { SSEStreamingApi } from "hono/streaming";
import { streamChatCompletionSse } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { ChatCompletionRequest } from "../src/openai.js";
import type { OpenAIEndpointContext } from "../src/openai-endpoint.js";
import type { ProxyContext } from "../src/proxy-context.js";

// B2 regression: the SSE heartbeat must survive the assistant *role bootstrap*
// chunk (emitted by sink.begin() before the prefill) and stop only on the first
// *content* delta. The earlier bug stopped on the first chunk written, which is
// the role chunk — silencing the heartbeat for the entire prefill gap.
//
// This drives the real agent-turn -> stream-sink -> app.ts streaming wiring with
// the SDK agent/run faked (as the suite mocks the SDK elsewhere): `send` resolves
// immediately, then after a no-content prefill gap delivers the first text delta
// through the SDK `onDelta` callback — exactly the ordering the heartbeat must
// outlive.

const HEARTBEAT_MS = 10;
const PREFILL_MS = 90;

function testConfig(): AppConfig {
  return {
    CURSOR_API_KEY: "cursor_test",
    CURSOR_CWD: "/repo",
    PORT: 8080,
    HOST: "127.0.0.1",
    DEFAULT_MODEL: "composer-2.5",
    AUTH_KEY: undefined,
    DEBUG_STREAM: false,
    CURSOR_INCLUDE_THINKING: false,
    CURSOR_EMIT_TOOL_CALLS: false,
    CURSOR_ASSISTANT_TEXT_MODE: "live",
    CURSOR_ENABLE_SESSIONS: false,
    CURSOR_AUTO_SESSION: false,
    CURSOR_SESSION_TTL_MS: 60_000,
    CURSOR_SESSION_MAX: 8,
    CURSOR_STREAM_TTFB_TIMEOUT_MS: 60_000,
    CURSOR_STREAM_IDLE_TIMEOUT_MS: 60_000,
    CURSOR_STREAM_HEARTBEAT_MS: HEARTBEAT_MS,
  } as AppConfig;
}

type SdkDelta = (arg: { update: { type: string; text: string } }) => Promise<void>;

// A fake agent whose `send` mirrors a slow-prefill Opus turn: it returns a run
// immediately, then emits its single content delta only after PREFILL_MS, during
// which the upstream produces nothing.
function fakePreparedAgent() {
  return {
    agentId: "agent-test",
    async send(_payload: unknown, options: { onDelta: SdkDelta }) {
      let resolveStream!: () => void;
      const streamDone = new Promise<void>((resolve) => {
        resolveStream = resolve;
      });
      setTimeout(() => {
        void (async () => {
          await options.onDelta({ update: { type: "text-delta", text: "Hello" } });
          resolveStream();
        })();
      }, PREFILL_MS);
      return {
        id: "run-test",
        supports: () => false,
        async cancel() {},
        async *stream() {
          await streamDone;
        },
        async wait() {
          return { status: "completed", result: "Hello" };
        },
      };
    },
    async [Symbol.asyncDispose]() {},
  };
}

// Minimal proxy whose session store hands back the fake agent, so executeAgentTurn
// never touches the real SDK (no Agent.create / network).
function fakeProxy(request: ChatCompletionRequest): ProxyContext {
  const agent = fakePreparedAgent();
  const sessions = {
    async prepareChatSession() {
      return {
        agent,
        agentId: agent.agentId,
        deltaMessages: request.messages,
        sessionKey: undefined,
        retainAgent: false,
        isNewAgent: true,
      };
    },
    async withAgentTurn<T>(_agentId: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    commitChatSession() {
      return undefined;
    },
    async releaseChatAgent() {},
    evictSession() {},
  };
  return { config: testConfig(), sessions } as unknown as ProxyContext;
}

function fakeSseStream(): { stream: SSEStreamingApi; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    write: async (input: string | Uint8Array) => {
      writes.push(typeof input === "string" ? input : input.toString());
      return stream;
    },
    writeSSE: async (message: { data: string }) => {
      writes.push(`event-data: ${message.data}`);
      return stream;
    },
  } as unknown as SSEStreamingApi;
  return { stream, writes };
}

describe("SSE heartbeat wiring (agent-turn <-> app.ts)", () => {
  test("pings keep going through the role chunk and stop on the first content delta", async () => {
    const request: ChatCompletionRequest = {
      model: "composer-2.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    } as ChatCompletionRequest;

    const proxy = fakeProxy(request);
    const { stream, writes } = fakeSseStream();
    const ctx = {
      proxy,
      request,
      sessionHeaders: {},
      abortSignal: new AbortController().signal,
    } as unknown as OpenAIEndpointContext<ChatCompletionRequest>;

    await streamChatCompletionSse(ctx, { stream, setHeaders: () => {} });

    const log = writes.join("\u0000");
    const roleIdx = log.indexOf('"role":"assistant"');
    const firstPingIdx = log.indexOf(": ping");
    const lastPingIdx = log.lastIndexOf(": ping");
    const contentIdx = log.indexOf('"content":"Hello"');

    // The role bootstrap chunk and the content delta both went out.
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(contentIdx).toBeGreaterThan(roleIdx);

    // The heartbeat outlived the role chunk (this is the B2 fix — with the bug,
    // the role chunk stops the heartbeat and no ping is ever emitted).
    expect(firstPingIdx).toBeGreaterThan(roleIdx);

    // Multiple pings bridged the prefill gap, and all of them landed before the
    // first content delta — i.e. the heartbeat stopped exactly on first content.
    const pingCount = writes.filter((w) => w === ": ping\n\n").length;
    expect(pingCount).toBeGreaterThanOrEqual(2);
    expect(lastPingIdx).toBeLessThan(contentIdx);
  });
});
