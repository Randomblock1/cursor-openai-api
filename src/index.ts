import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { authHealth } from "./auth-health.js";
import { loadConfig } from "./config.js";
import { isAuthWedgeError } from "./errors.js";
import { startRecycle } from "./recycle.js";

/**
 * Keep the proxy alive through stray async faults. The Cursor SDK's gRPC/HTTP2
 * transport can surface late rejections (e.g. NGHTTP2_FRAME_SIZE_ERROR) after a
 * run has already been handled; without a guard those crash the whole process
 * and take every cached session down with them. Log and continue instead — a
 * single wedged run must not kill the server.
 *
 * Exception: a stale-auth wedge surfaces here too, as a late `[unauthenticated]`
 * rejection thrown from the SDK transport *outside* any turn try/catch (so the
 * agent-turn auth-health hook never sees it). If we merely logged-and-continued
 * those, the process would stay alive but permanently unauthenticated — every
 * completion failing until an external restart. Route them to the auth-health
 * monitor instead: after a short streak it exit(1)s and a supervisor relaunches
 * with fresh auth (seconds, no human page).
 */
function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[cursor-openai-api] unhandledRejection:",
      reason instanceof Error ? reason.stack ?? reason.message : reason,
    );
    if (isAuthWedgeError(reason)) authHealth.recordAuthWedge();
  });
  process.on("uncaughtException", (err) => {
    console.error(
      "[cursor-openai-api] uncaughtException:",
      err instanceof Error ? err.stack ?? err.message : err,
    );
    if (isAuthWedgeError(err)) authHealth.recordAuthWedge();
  });
}

installProcessGuards();

const config = loadConfig();
const app = createApp(config);

serve(
  {
    fetch: app.fetch,
    port: config.PORT,
    hostname: config.HOST,
  },
  (info) => {
    console.log(
      `cursor-openai-api listening on http://${info.address}:${info.port}`,
    );
    console.log(`  cwd: ${config.CURSOR_CWD}`);
    console.log(`  default model: ${config.DEFAULT_MODEL}`);
  },
);

// Proactive pre-expiry recycle: exit cleanly before the ~hourly Cursor token
// expiry so a process supervisor relaunches with fresh auth and a live turn
// never hits an expired token. Drains in-flight turns first. Disabled when
// CURSOR_PROXY_RECYCLE_MS=0.
startRecycle({
  afterMs: config.CURSOR_PROXY_RECYCLE_MS,
  graceMs: config.CURSOR_PROXY_RECYCLE_GRACE_MS,
});
