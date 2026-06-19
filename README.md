# cursor-openai-api

OpenAI-compatible HTTP proxy for [Cursor SDK](https://cursor.com/docs/sdk/typescript) local agents. Point OpenAI clients at this server to use Cursor models (for example `composer-2` or `composer-2.5`) with your Cursor plan usage via `CURSOR_API_KEY`.

<img width="1600" height="924" alt="Screenshot_20260523_032144" src="https://github.com/user-attachments/assets/19988b4e-e58e-45cb-a1a9-d41fc6915a1f" />

## Requirements

- [Bun](https://bun.sh) (recommended) for the default install, dev, and test scripts
- Node.js 18+ to run the server via the npm/Node scripts (`build`, `start:node`, `dev:node`)
- A Cursor API key from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)

## Install

With Bun (recommended):

```bash
bun install
```

With npm:

```bash
npm install
```

## Configure

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CURSOR_API_KEY` | yes | — | Cursor user or team service account key |
| `CURSOR_CWD` | no | `process.cwd()` | Local workspace directory for the agent |
| `PORT` | no | `8080` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP listen host |
| `DEFAULT_MODEL` | no | `composer-2.5` | Model when the client omits `model` |
| `AUTH_KEY` | no | — | If set, clients must send `Authorization: Bearer <value>` |
| `CURSOR_INCLUDE_THINKING` | no | `true` | Stream thinking as `reasoning_content` / `reasoning` on deltas and the final message |
| `CURSOR_ASSISTANT_TEXT_MODE` | no | `live` | How assistant `content` is streamed when text and thinking interleave: `live`, `final-content`, or `preamble-as-reasoning` (see [Assistant text modes](#assistant-text-modes)) |
| `CURSOR_EMIT_TOOL_CALLS` | no | `false` | Surface Cursor's internal tool use as OpenAI `tool_calls` (see [Tool calls](#tool-calls) below) |
| `CURSOR_ENABLE_SESSIONS` | no | `true` | Reuse Cursor SDK agents when the client supplies a session id |
| `CURSOR_AUTO_SESSION` | no | `true` | Reuse agents when a request extends a prior in-memory conversation (for clients like AI SDK that resend full `messages[]`) |
| `CURSOR_SESSION_TTL_MS` | no | `1800000` | Evict idle cached agents after this many ms |
| `CURSOR_SESSION_MAX` | no | `64` | Max concurrent cached agents |
| `CURSOR_TOOL_TIER` | no | `tiered` | Client-tool schema tiering on the native `customTools` channel: `full` (every tool full schema), `tiered` (resident tools full, long tail as compact signatures), or `brief` (all compact). Provider-neutral, env-only — there is no per-request tier field |
| `CURSOR_TOOL_RESIDENT` | no | (none) | Comma-separated tool names kept resident (full schema) in `tiered` mode. Opt-in only — when unset, every tool is rendered as a compact signature |
| `DEBUG_STREAM` | no | `false` | Include agent status events as annotated `content` in streams |

## Run

With Bun (recommended):

```bash
export CURSOR_API_KEY="cursor_..."
export CURSOR_CWD="$(pwd)"
bun run start
```

With npm and Node:

```bash
export CURSOR_API_KEY="cursor_..."
export CURSOR_CWD="$(pwd)"
npm run start:node
```

`start:node` compiles TypeScript to `dist/` and runs `node dist/index.js`. For development without a build step:

```bash
npm run dev:node
```

The server source uses Node-compatible APIs (`process.env`, `@hono/node-server`) and no `Bun.*` runtime APIs. Bun runs TypeScript directly; the Node scripts compile with `tsc` or use `tsx` for watch mode.

## Usage

### curl

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2",
    "messages": [{"role": "user", "content": "Summarize this repo in one paragraph."}]
  }'
```

Streaming:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2",
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello."}]
  }'
```

List models (includes `display_name`, `description`, `cursor_aliases`, `cursor_parameters`, `cursor_variants`, and proxy speed aliases when available):

```bash
curl http://localhost:8080/v1/models
```

### Composer fast mode

On Cursor's catalog, **Composer 2 / 2.5 default to fast mode** (`fast=true`) — higher throughput, different pricing than the standard tier. That is the SDK/product default when you pass `model: "composer-2.5"` with no extra params.

To use the **standard (non-fast) tier** via the SDK or this proxy:

```json
"cursor_model_params": [{ "id": "fast", "value": "false" }]
```

Or use the proxy aliases (see below): `"model": "composer-2.5-slow"`.

Other families (GPT, Opus, Codex, etc.) expose the same `fast` parameter when supported; their **defaults vary** (for example Opus and GPT-5.5 often default to `fast=false`). Call `GET /v1/models` or `Cursor.models.list()` to see `cursor_parameters` and preset `cursor_variants` for your account.

### Speed aliases (`*-slow` / `*-fast`)

For every catalog model that advertises both `fast=false` and `fast=true`, this proxy also lists and accepts:

| Request model | Effect |
|---------------|--------|
| `<base>-slow` | Sets `fast=false` on `<base>` (standard tier for Composer) |
| `<base>-fast` | Sets `fast=true` on `<base>` |

Examples: `composer-2.5-slow`, `claude-opus-4-7-fast`, `gpt-5.5-slow`.

Explicit `cursor_model_params` with `id: "fast"` must agree with the alias; conflicting values are rejected. Aliases are not sent to Cursor as model ids — the proxy resolves to the base id plus params. Each request passes the resolved model (id + params) on `agent.send()`, so you can switch between `*-slow` and `*-fast` on a reused session without creating a new agent.

Model parameters and thinking effort:

```bash
# Standard (non-fast) Composer tier — alias or explicit param
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5-slow",
    "messages": [{"role": "user", "content": "Summarize this repo."}]
  }'

curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "reasoning_effort": "high",
    "cursor_model_params": [{"id": "thinking_effort", "value": "high"}],
    "stream": true,
    "messages": [{"role": "user", "content": "Explain your plan briefly."}]
  }'
```

Disable thinking in the response:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "cursor_include_thinking": false,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### OpenAI Responses API

```bash
curl http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "instructions": "You are a helpful assistant.",
    "input": "Say hello in one sentence."
  }'
```

Streaming uses Responses SSE events (`response.created`, `response.output_text.delta`, `response.completed`):

```bash
curl -N http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "input": "Say hello.",
    "stream": true
  }'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-auth-key",  # or any value if AUTH_KEY is unset
)

response = client.chat.completions.create(
    model="composer-2",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

Responses API (recommended for newer SDKs):

```python
response = client.responses.create(
    model="composer-2.5",
    instructions="You are a helpful assistant.",
    input="Hello!",
)
print(response.output_text)
```

## Assistant text modes

`CURSOR_ASSISTANT_TEXT_MODE` (or per-request `cursor_assistant_text_mode`) controls how assistant `content` is delivered when a turn alternates between thinking and text. It is independent of `CURSOR_INCLUDE_THINKING`: thinking is on/off via that flag; the mode only affects `content` routing.

| Mode | Behavior | Best for |
|------|----------|----------|
| `live` (default) | Stream every `content` delta immediately | Generic OpenAI clients, lowest latency |
| `final-content` | Buffer all assistant text; emit one `content` chunk at turn-end | Clients that need the response part after thinking, OK with early+final text merged |
| `preamble-as-reasoning` | Buffer text; if a later thinking or tool-call boundary arrives, emit buffered text as `reasoning_content`; final text segment as `content` at turn-end | OpenCode via `@ai-sdk/openai-compatible` |

**Why multiple response blocks are not possible over chat completions:** `@ai-sdk/openai-compatible` maps every `delta.content` into a single AI SDK text part (`txt-0`) and only closes it when the HTTP stream ends. OpenCode can render multiple text parts, but this provider never emits mid-stream `text-end` boundaries. The proxy cannot fix that without patching the SDK; modes above are the supported workarounds.

Per-request override: `cursor_assistant_text_mode` on `POST /v1/chat/completions` bodies.

## OpenCode

OpenCode uses `@ai-sdk/openai-compatible`, which collapses all `content` into one text block per stream. For correct **Thought → Response** ordering when the model interleaves thinking and text, set:

```bash
export CURSOR_INCLUDE_THINKING=true
export CURSOR_ASSISTANT_TEXT_MODE=preamble-as-reasoning
export CURSOR_EMIT_TOOL_CALLS=false
```

Client tool loop (OpenCode's own `tools` array) uses the **same** assistant text mode for visible text parsed from the stream — set `preamble-as-reasoning` there too if you want ordering fixes during tool turns.

### Recommended setup

**API:**

```bash
export CURSOR_API_KEY="cursor_..."
export CURSOR_CWD="$(pwd)"
export CURSOR_ASSISTANT_TEXT_MODE=preamble-as-reasoning
bun run start
```

Per-request overrides: `cursor_include_thinking`, `cursor_assistant_text_mode`, `cursor_emit_tool_calls`.

**OpenCode** (`opencode.json`) — point at the proxy and declare interleaved reasoning on the model:

```json
{
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "cursor-openai-api",
      "options": {
        "baseURL": "http://localhost:8080/v1"
      },
      "models": {
        "composer-2.5": {
          "name": "Composer 2.5 (Fast)",
          "interleaved": { "field": "reasoning_content" },
          "cost": { "input": 0.5, "output": 2.5, "cache_read": 0.2 },
          "limit": { "context": 200000, "output": 65536 }
        }
      }
    }
  }
}
```

`interleaved.field` must be `reasoning_content` so OpenCode maps streamed thinking into separate **Thought** parts. The model-level `reasoning` flag in OpenCode config is separate from proxy thinking; you can leave `reasoning: false` there as long as the proxy keeps `CURSOR_INCLUDE_THINKING` enabled.

### What you see in the UI (`preamble-as-reasoning`)

| Stream | When it updates |
|--------|-----------------|
| Thinking (`reasoning_content`) | Live — includes preamble text re-routed when the model goes back to thinking or reaches a tool-call boundary |
| Tool calls (`CURSOR_EMIT_TOOL_CALLS=true` or client tool loop) | Live |
| Assistant response (`content`) | **Once**, when the turn ends (final text segment only) |

### Choosing a mode by app

| If you need… | Set |
|-------------|-----|
| OpenCode: best interleaved order + visible thinking | `CURSOR_ASSISTANT_TEXT_MODE=preamble-as-reasoning`, `CURSOR_INCLUDE_THINKING=true` |
| Any client: token-by-token assistant text | `CURSOR_ASSISTANT_TEXT_MODE=live` (default) |
| Response after thinking, all assistant text kept as `content` | `CURSOR_ASSISTANT_TEXT_MODE=final-content` |
| No thinking stream | `CURSOR_INCLUDE_THINKING=false` |
| Cursor internal tools as `tool_calls` | `CURSOR_EMIT_TOOL_CALLS=true` (usually **not** for OpenCode) |

## API surface

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness |
| `GET /v1/models` | Cursor models via `Cursor.models.list()` |
| `POST /v1/chat/completions` | Chat completions (JSON or SSE stream) |
| `POST /v1/responses` | Responses API (JSON or typed SSE stream) |

## Compatibility notes

- **Runtime**: Local Cursor SDK agents only (`local: { cwd }`). Cloud agents are not exposed in this version.
- **Messages**: OpenAI `messages[]` (chat) or `input` / `instructions` (responses) are serialized into one Cursor prompt per request; there is no server-side OpenAI thread store.
- **Responses API**: `POST /v1/responses` accepts string or message-array `input`, maps to the same Cursor agent path as chat completions, and returns typed output items (`message`, `reasoning`, `function_call`). Streaming emits Responses lifecycle events.
- **Sessions**: When `CURSOR_ENABLE_SESSIONS` is on (default), reuse a Cursor SDK agent by sending the same session id on each request (`X-Session-ID` header or `metadata.session_id` / `metadata.sessionId`), or rely on **auto-session** (`CURSOR_AUTO_SESSION`, default on): if a new request's `messages[]` extends a cached conversation prefix (same base catalog model id), the proxy reuses the agent without an explicit session header. Session matching uses the SDK catalog id (e.g. `composer-2.5`), not `*-slow` / `*-fast` aliases. Each turn still passes the request's resolved `model` (including `fast` and other `cursor_model_params`) on `agent.send()`, so speed aliases can change mid-conversation on the same agent. The OpenAI `user` field is passed through for client abuse-tracking only and is **not** used as a session key. Resume a known agent with `metadata.cursor_agent_id` (maps to `Agent.resume()`). Follow-ups only forward new messages to `agent.send()`; the agent keeps native multi-turn context.
- **Multi-turn history**: Prior assistant `reasoning_content` / `reasoning` in chat `messages[]` is preserved when serializing to the Cursor prompt. Chat-only request fields such as `response_format` and unknown passthrough JSON fields are included in the prompt.
- **Finish reasons**: Emits `length` when `max_tokens` is set and reported completion tokens reach that cap; emits `tool_calls` only when Cursor tool calls are surfaced in the OpenAI response.
- **Stream errors**: Errors are sent as standard OpenAI-style JSON in SSE `data:` lines (no separate `event: error`), matching `@ai-sdk/openai-compatible` parsers.
- **Cursor metadata**: Chat completion responses and chat stream chunks include `cursor` with `agent_id`, `run_id`, `session_id`, and when available `request_id`, `actual_model`, `thinking_duration_ms`, `cache_write_tokens`. All endpoints also return available `X-Cursor-*` headers for agent, run, session, request, and actual model ids.
- **Multimodal**: User messages with `image_url` / data URLs are sent as `SDKUserMessage` with `images` when possible (not only `[image: …]` text).
- **Streaming**: Text, thinking, and tool deltas come from `onDelta` (`text-delta`, `thinking-delta`, tool events). `run.stream()` only updates Cursor metadata (`actual_model`, `request_id`, `thinking_duration_ms`) and optional `DEBUG_STREAM` status lines; duplicate thinking messages from `run.stream()` are intentionally ignored.
- **Assistant text modes**: `CURSOR_ASSISTANT_TEXT_MODE` / `cursor_assistant_text_mode` control `live`, `final-content`, and `preamble-as-reasoning` routing. Applies to SDK text deltas and client tool loop visible text. See [Assistant text modes](#assistant-text-modes) and [OpenCode](#opencode).
- **Client abort**: Dropping the HTTP request aborts the in-flight run via `run.cancel()` when supported.
- **Model parameters**: Pass Cursor SDK params via `cursor_model_params` (`[{ "id", "value" }]`). Chat completions also accept the convenience alias `reasoning_effort`; Responses requests use `reasoning.effort`. These aliases map only when the model catalog defines a thinking-effort param. Explicit `cursor_model_params` win on duplicate ids.
- **Fast mode**: Composer defaults to `fast=true` in Cursor's catalog; disable with `cursor_model_params: [{ "id": "fast", "value": "false" }]` or model id `composer-2.5-slow`. Use `*-fast` / `*-slow` proxy aliases for any model that advertises both `fast` param values (see [Speed aliases](#speed-aliases--slow--fast)).
- **Thinking**: When enabled (default), thinking text is exposed as `reasoning_content` (and `reasoning`) on stream deltas and on the final assistant message. Models with a thinking-effort parameter get a default effort automatically so Cursor actually emits thinking. Set `cursor_include_thinking: false` per request or `CURSOR_INCLUDE_THINKING=false` globally to disable.

### Tool calls

Three modes:

1. **Plain chat** (default) — `CURSOR_EMIT_TOOL_CALLS=false` and no `tools` on the request. Cursor may use its own tools in `CURSOR_CWD`, but the proxy does not surface them; `finish_reason` stays `stop` and only assistant text/reasoning is returned.

2. **Client tool loop** (OpenCode / AI SDK) — When the request includes a non-empty `tools` array and `tool_choice` is not `"none"`, the proxy enters **client tool loop** mode automatically:
   - Registers **your** tools as Cursor SDK `customTools`, so the model invokes them through its native tool channel rather than emitting parsed-from-prose text markers.
   - Captures each native invocation through an in-process bridge and returns OpenAI `tool_calls` with `finish_reason: "tool_calls"`. Parallel tool calls in one turn are all captured and surfaced as distinct, paired `tool_call` ids.
   - Supports function tools only; non-function tool definitions are rejected.
   - Your client executes tools locally and resends `tool` / `assistant.tool_calls` messages; the proxy does not run client tool handlers.
   - `CURSOR_EMIT_TOOL_CALLS` is ignored for these requests (Cursor-internal tool events are not forwarded).
   - `POST /v1/responses` with `tools` is rejected (use chat completions).
   - **Schema tiering** (`CURSOR_TOOL_TIER`, default `tiered`): your client already holds each tool's real schema, so on the native channel the model only needs the tool name and argument names to emit a correct call. In `tiered` mode the long tail is registered as a compact signature (name + arg names) while tools listed in `CURSOR_TOOL_RESIDENT` keep their full schema; `full` registers every tool with its full schema and `brief` makes every tool compact. `CURSOR_TOOL_RESIDENT` is opt-in (e.g. `CURSOR_TOOL_RESIDENT=read_file,run_command`); with no opt-in every tool is compact. Tiering is env-only — the wire format stays a standard OpenAI request.

3. **Cursor tool visibility** — `CURSOR_EMIT_TOOL_CALLS=true` (or `cursor_emit_tool_calls: true`) only when **not** in client tool loop. Surfaces Cursor SDK `tool-call-*` deltas as best-effort OpenAI `tool_calls` (Read, Shell, etc.). Usually **not** what you want alongside OpenCode's own `tools` array.

**Note:** The SDK may still run Cursor's built-in tools in the workspace alongside your registered `customTools`. The HTTP response only exposes **client** `tool_calls`. If you see unexpected file changes during client tool loops, treat that as a known limitation until a stricter SDK guard exists.

- **Usage fields**: Mapped from Cursor `turn-ended` deltas (`onDelta` on `agent.send()`). `prompt_tokens` is total input-side tokens (input + cache read + cache write); `prompt_tokens_details.cached_tokens` reports cache reads per the OpenAI usage schema. Omitted when the SDK does not report usage for a turn.
- **DEBUG_STREAM**: Status events only (`[status] ...` in `content`). Thinking uses `reasoning_content`, not `DEBUG_STREAM`.
- **Unknown fields**: Extra JSON fields on chat completion requests are accepted and included in the prompt passthrough. Responses requests accept unknown fields for client compatibility, but only the supported fields listed above are mapped to the Cursor turn.

## Development

With Bun:

```bash
bun test
bun run typecheck
```

With npm:

```bash
npm run typecheck
npm run build
```

Tests use Bun's test runner (`bun:test`); run them with `bun test` even when you use npm for install and Node for the server.

Integration tests against a real agent require a valid `CURSOR_API_KEY` and are not run in CI by default.
