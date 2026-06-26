import { z } from "zod";
import {
  ASSISTANT_TEXT_MODES,
  DEFAULT_ASSISTANT_TEXT_MODE,
} from "./assistant-text-mode.js";

const envSchema = z.object({
  CURSOR_API_KEY: z.string().min(1, "CURSOR_API_KEY is required"),
  CURSOR_CWD: z.string().min(1).default(process.cwd()),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  DEFAULT_MODEL: z.string().default("composer-2.5"),
  AUTH_KEY: z.string().optional(),
  DEBUG_STREAM: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  CURSOR_INCLUDE_THINKING: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  // Cursor runs its own tools locally; keep them hidden unless explicitly requested.
  CURSOR_EMIT_TOOL_CALLS: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  CURSOR_ASSISTANT_TEXT_MODE: z
    .enum(ASSISTANT_TEXT_MODES)
    .optional()
    .default(DEFAULT_ASSISTANT_TEXT_MODE),
  CURSOR_ENABLE_SESSIONS: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  CURSOR_AUTO_SESSION: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  CURSOR_SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  CURSOR_SESSION_MAX: z.coerce.number().int().positive().default(64),
  // Proactive pre-expiry recycle. The Cursor access token derived from
  // CURSOR_API_KEY expires ~hourly and is not refreshed in-process, so a
  // long-lived proxy eventually wedges with `[unauthenticated]` on every run
  // (see recycle.ts / auth-health.ts). Exit cleanly after this much uptime —
  // below the ~60min token TTL — so a process supervisor relaunches with fresh
  // auth before a live turn ever hits an expired token. `0` disables it.
  CURSOR_PROXY_RECYCLE_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(45 * 60 * 1000),
  // Grace window after the recycle deadline: if in-flight turns never drain,
  // force the restart this long after the deadline anyway.
  CURSOR_PROXY_RECYCLE_GRACE_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5 * 60 * 1000),
});

export type AppConfig = z.infer<typeof envSchema>;

const CURSOR_API_KEY_DOCS_URL =
  "https://cursor.com/dashboard/integrations";

function formatConfigError(
  env: NodeJS.ProcessEnv,
  issues: z.core.$ZodIssue[],
): string {
  const apiKey = env.CURSOR_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return [
      "CURSOR_API_KEY is not set.",
      "",
      "Create a key in Cursor Dashboard → Integrations:",
      `  ${CURSOR_API_KEY_DOCS_URL}`,
      "",
      "Then export it before starting the server:",
      '  export CURSOR_API_KEY="cursor_..."',
      "  bun run start",
    ].join("\n");
  }

  const details = issues
    .map((issue) => {
      const field = issue.path.join(".") || "configuration";
      return `  ${field}: ${issue.message}`;
    })
    .join("\n");

  return ["Invalid configuration:", details].join("\n");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(formatConfigError(env, parsed.error.issues));
  }
  return parsed.data;
}
