import type { Context, Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";
import { mapCursorError } from "./errors.js";
import {
  extractSessionHeaders,
  openAIErrorBody,
  proxyErrorResponse,
  zodValidationErrorResponse,
} from "./http-utils.js";
import type { ProxyContext } from "./proxy-context.js";
import type { SessionRequestHeaders } from "./session-keys.js";

export interface OpenAIEndpointContext<TRequest> {
  c: Context;
  proxy: ProxyContext;
  request: TRequest;
  sessionHeaders: SessionRequestHeaders;
  abortSignal: AbortSignal;
}

export interface OpenAIStreamSink {
  stream: SSEStreamingApi;
  setHeaders: (headers: Record<string, string>) => void;
}

/**
 * While awaiting the upstream's first byte, emit an SSE comment ping every
 * `intervalMs` so a slow prefill reads as live instead of an indefinite silent
 * hang. Returns a stop function — call it once the first real (content-bearing)
 * chunk is written (and again on teardown; it is idempotent). No-op when
 * `intervalMs <= 0`, which is the supported disable path.
 *
 * BEST-EFFORT ONLY: these comment pings keep generic OpenAI clients and
 * intermediaries (proxies, load balancers) from treating the connection as idle.
 * They CANNOT keep a consumer alive when it ignores SSE comments for staleness.
 * The TTFB/idle timeouts
 * (CURSOR_STREAM_TTFB_TIMEOUT_MS / CURSOR_STREAM_IDLE_TIMEOUT_MS) are the real
 * protection for a slow prefill; the heartbeat is purely cosmetic liveness.
 */
export function startSseHeartbeat(
  stream: SSEStreamingApi,
  intervalMs: number,
): () => void {
  if (intervalMs <= 0) return () => {};
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    // SSE comment line: clients ignore it, but the bytes prove liveness.
    void stream.write(": ping\n\n").catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

export function registerOpenAIEndpoint<TRequest extends { stream?: boolean }>(
  app: Hono,
  proxy: ProxyContext,
  options: {
    path: string;
    schema: ZodType<TRequest>;
    run: (
      ctx: OpenAIEndpointContext<TRequest>,
    ) => Promise<{ body: unknown; headers?: Record<string, string> }>;
    stream: (ctx: OpenAIEndpointContext<TRequest>, sink: OpenAIStreamSink) => Promise<void>;
  },
): void {
  app.post(
    options.path,
    zValidator("json", options.schema, (result) => {
      if (!result.success) {
        return zodValidationErrorResponse(result.error.issues);
      }
    }),
    async (c) => {
      const request = c.req.valid("json") as TRequest;
      const ctx: OpenAIEndpointContext<TRequest> = {
        c,
        proxy,
        request,
        sessionHeaders: extractSessionHeaders(c),
        abortSignal: c.req.raw.signal,
      };

      if (request.stream) {
        return streamWithOpenAIErrors(c, async (stream, setHeaders) => {
          await options.stream(ctx, { stream, setHeaders });
        });
      }

      try {
        const { body, headers } = await options.run(ctx);
        return c.json(body, 200, headers);
      } catch (err) {
        return proxyErrorResponse(mapCursorError(err));
      }
    },
  );
}

function streamWithOpenAIErrors(
  c: Context,
  handler: (
    stream: SSEStreamingApi,
    setHeaders: (headers: Record<string, string>) => void,
  ) => Promise<void>,
): Response {
  return streamSSE(c, async (stream) => {
    try {
      await handler(stream, (headers) => setStreamingResponseHeaders(c, headers));
    } catch (err) {
      await stream.writeSSE({
        data: JSON.stringify(openAIErrorBody(mapCursorError(err))),
      });
      await stream.writeSSE({ data: "[DONE]" });
    }
  });
}

function setStreamingResponseHeaders(
  c: Context,
  headers: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(headers)) {
    c.res.headers.set(key, value);
  }
}
