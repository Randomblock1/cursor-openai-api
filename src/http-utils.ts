import type { ZodIssue } from "zod";
import type { Context } from "hono";
import type { OpenAIErrorBody } from "./openai.js";
import { openAIError } from "./openai.js";
import type { ProxyError } from "./errors.js";
import type { SessionRequestHeaders } from "./session-keys.js";

export function formatZodIssues(issues: ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

export function extractSessionHeaders(c: Context): SessionRequestHeaders {
  return {
    "x-session-id": c.req.header("x-session-id"),
    "x-cursor-cwd": c.req.header("x-cursor-cwd"),
  };
}

export function proxyErrorResponse(err: ProxyError): Response {
  return openAIError(err.message, err.type, err.status, err.code);
}

export function openAIErrorBody(err: ProxyError): OpenAIErrorBody {
  return {
    error: {
      message: err.message,
      type: err.type,
      code: err.code ?? null,
      param: null,
    },
  };
}

export function zodValidationErrorResponse(issues: ZodIssue[]): Response {
  return openAIError(formatZodIssues(issues), "invalid_request_error", 400);
}
