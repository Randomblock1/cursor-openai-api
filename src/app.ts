import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import { mapCursorError } from "./errors.js";
import { listModels } from "./models.js";
import { runChatCompletion, streamChatCompletion } from "./chat-handlers.js";
import { runResponse, streamResponse } from "./responses-handlers.js";
import { proxyErrorResponse } from "./http-utils.js";
import {
  chatCompletionRequestSchema,
  openAIError,
  type ChatCompletionRequest,
} from "./openai.js";
import {
  registerOpenAIEndpoint,
  startSseHeartbeat,
  type OpenAIEndpointContext,
  type OpenAIStreamSink,
} from "./openai-endpoint.js";
import { createProxyContext } from "./proxy-context.js";
import { isContentBearingChunk } from "./stream.js";
import { responsesRequestSchema, type ResponsesStreamWrite } from "./responses.js";

/**
 * SSE handler for streaming chat completions. Exported so the heartbeat wiring
 * — keeping the connection alive through the slow prefill and stopping the
 * pings only on the first *content-bearing* delta (not the assistant role
 * bootstrap chunk the sink emits first) — can be exercised directly in tests.
 */
export async function streamChatCompletionSse(
  { proxy, request, sessionHeaders, abortSignal }: OpenAIEndpointContext<ChatCompletionRequest>,
  { stream, setHeaders }: OpenAIStreamSink,
): Promise<void> {
  // Keep the connection observably alive during a slow prefill. Best-effort
  // for generic OpenAI clients/intermediaries only — the real protection is
  // the TTFB/idle timeout, not this heartbeat (see startSseHeartbeat).
  const stopHeartbeat = startSseHeartbeat(
    stream,
    proxy.config.CURSOR_STREAM_HEARTBEAT_MS,
  );
  try {
    const { headers: cursorHeaders } = await streamChatCompletion(
      proxy,
      request,
      async (chunk, chunkHeaders) => {
        setHeaders(chunkHeaders);
        if (chunk === "[DONE]") {
          stopHeartbeat();
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }
        // Stop ONLY on the first content-bearing delta. The sink emits the
        // assistant role bootstrap chunk through this same callback before the
        // prefill begins; stopping on it would silence the heartbeat for the
        // entire (multi-minute) prefill gap.
        if (isContentBearingChunk(chunk)) stopHeartbeat();
        await stream.writeSSE({ data: JSON.stringify(chunk) });
      },
      sessionHeaders,
      abortSignal,
    );
    setHeaders(cursorHeaders);
  } finally {
    stopHeartbeat();
  }
}

export function createApp(config: AppConfig): Hono {
  const proxy = createProxyContext(config);
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    if (config.AUTH_KEY) {
      const auth = c.req.header("Authorization");
      const expected = `Bearer ${config.AUTH_KEY}`;
      if (auth !== expected) {
        return openAIError("Invalid API key", "invalid_api_key", 401);
      }
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({ status: "ok", runtime: "cursor-openai-api" }),
  );

  app.get("/v1/models", async (c) => {
    try {
      const models = await listModels(config.CURSOR_API_KEY);
      return c.json(models);
    } catch (err) {
      return proxyErrorResponse(mapCursorError(err));
    }
  });

  registerOpenAIEndpoint(app, proxy, {
    path: "/v1/responses",
    schema: responsesRequestSchema,
    run: async ({ proxy, request, sessionHeaders, abortSignal }) =>
      runResponse(proxy, request, sessionHeaders, abortSignal),
    stream: async ({ proxy, request, sessionHeaders, abortSignal }, { stream, setHeaders }) => {
      const cursorHeaders = await streamResponse(
        proxy,
        request,
        (async (event, data) => {
          await stream.writeSSE({
            event,
            data: JSON.stringify(data),
          });
        }) satisfies ResponsesStreamWrite,
        sessionHeaders,
        abortSignal,
      );
      setHeaders(cursorHeaders);
    },
  });

  registerOpenAIEndpoint(app, proxy, {
    path: "/v1/chat/completions",
    schema: chatCompletionRequestSchema,
    run: async ({ proxy, request, sessionHeaders, abortSignal }) =>
      runChatCompletion(proxy, request, sessionHeaders, abortSignal),
    stream: streamChatCompletionSse,
  });

  app.notFound(() =>
    openAIError("Not found", "invalid_request_error", 404),
  );

  return app;
}
