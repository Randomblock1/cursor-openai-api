import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// http.Server backstops. These bound how long the server waits to *receive* a
// request (headers/body) from a client — they do NOT cap the long-lived
// streaming response, so a legitimately slow upstream prefill is unaffected
// (that path is guarded by the per-stream TTFB/idle watchdog instead). They
// guard against slowloris-style half-open requests leaking sockets.
const SERVER_HEADERS_TIMEOUT_MS = 60_000;
const SERVER_REQUEST_TIMEOUT_MS = 5 * 60_000;

const config = loadConfig();
const app = createApp(config);

serve(
  {
    fetch: app.fetch,
    port: config.PORT,
    hostname: config.HOST,
    serverOptions: {
      headersTimeout: SERVER_HEADERS_TIMEOUT_MS,
      requestTimeout: SERVER_REQUEST_TIMEOUT_MS,
    },
  },
  (info) => {
    console.log(
      `cursor-openai-api listening on http://${info.address}:${info.port}`,
    );
    console.log(`  cwd: ${config.CURSOR_CWD}`);
    console.log(`  default model: ${config.DEFAULT_MODEL}`);
  },
);
