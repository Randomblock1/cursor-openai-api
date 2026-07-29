import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// Bun's HTTP/2 client hits NGHTTP2_FRAME_SIZE_ERROR against Cursor's Connect-RPC
// backend (api2.cursor.sh), crashing the proxy on the first agent turn. The
// @cursor/sdk reads CURSOR_USE_HTTP1 to opt its transport into HTTP/1.1, which
// sidesteps the crash. Default it on under Bun (where the bug lives) before any
// SDK import side effects run; Node keeps HTTP/2 (faster, no crash). Override
// explicitly with CURSOR_USE_HTTP1=0 to force HTTP/2 back on under Bun.
if (process.versions.bun && process.env.CURSOR_USE_HTTP1 === undefined) {
  process.env.CURSOR_USE_HTTP1 = "1";
}

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
