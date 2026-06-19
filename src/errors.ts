import { CursorAgentError } from "@cursor/sdk";

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

/**
 * True when an error is the SDK's "already has active run" rejection — raised
 * when a cached agent is reused while it still has a lingering non-terminal run
 * (e.g. a dropped stream / client disconnect). The message survives
 * `mapCursorError` wrapping, so this matches both the raw and wrapped forms.
 */
export function isActiveRunError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /already has active run/i.test(message);
}

export function mapCursorError(err: unknown): ProxyError {
  if (err instanceof ProxyError) return err;
  if (err instanceof CursorAgentError) {
    const status =
      err.name === "AuthenticationError"
        ? 401
        : err.name === "RateLimitError"
          ? 429
          : err.name === "ConfigurationError"
            ? 400
            : 502;
    return new ProxyError(err.message, status, "api_error", err.code);
  }
  if (err instanceof Error) {
    return new ProxyError(err.message, 500, "server_error");
  }
  return new ProxyError("Unknown error", 500, "server_error");
}
