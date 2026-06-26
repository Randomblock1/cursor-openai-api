import { z } from "zod";
import { ASSISTANT_TEXT_MODES } from "./assistant-text-mode.js";
import { messageContentSchema } from "./content-part-schema.js";
import { makeId } from "./ids.js";

export { messageContentSchema } from "./content-part-schema.js";

export const chatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "function"]),
    content: messageContentSchema.nullable().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.literal("function").optional(),
            function: z.object({
              name: z.string(),
              arguments: z.string(),
            }),
          })
          .passthrough(),
      )
      .optional(),
    function_call: z
      .object({
        name: z.string(),
        arguments: z.string(),
      })
      .passthrough()
      .optional(),
    reasoning_content: z.string().optional(),
    reasoning: z.string().optional(),
  })
  .passthrough();

export const modelParameterValueSchema = z.object({
  id: z.string().trim().min(1),
  value: z.string(),
});

const stopSchema = z.union([z.string(), z.array(z.string())]);

const chatCompletionRequestShape = {
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  user: z.string().optional(),
  cursor_model_params: z.array(modelParameterValueSchema).optional(),
  reasoning_effort: z.string().optional(),
  cursor_include_thinking: z.boolean().optional(),
  cursor_emit_tool_calls: z.boolean().optional(),
  cursor_assistant_text_mode: z.enum(ASSISTANT_TEXT_MODES).optional(),
  cursor_cwd: z.string().optional(),
  response_format: z.unknown().optional(),
  verbosity: z.string().optional(),
  stop: stopSchema.optional(),
  seed: z.number().int().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  stream_options: z.record(z.string(), z.unknown()).optional(),
  n: z.number().int().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().optional(),
  parallel_tool_calls: z.boolean().optional(),
  service_tier: z.string().optional(),
  store: z.boolean().optional(),
  prediction: z.unknown().optional(),
  audio: z.unknown().optional(),
  modalities: z.array(z.string()).optional(),
  web_search_options: z.unknown().optional(),
};

export const CHAT_COMPLETION_REQUEST_KEYS: ReadonlySet<string> = new Set(
  Object.keys(chatCompletionRequestShape),
);

export const chatCompletionRequestSchema = z
  .object(chatCompletionRequestShape)
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}

export function openAIError(
  message: string,
  type = "invalid_request_error",
  status = 400,
  code?: string,
): Response {
  const body: OpenAIErrorBody = {
    error: { message, type, param: null, code: code ?? null },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    reasoning_content?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: "stop" | "tool_calls" | "length" | null;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface CursorCompletionMeta {
  agent_id: string;
  run_id?: string;
  session_id?: string;
  request_id?: string;
  actual_model?: string;
  thinking_duration_ms?: number;
  cache_write_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: OpenAIUsage;
  cursor?: CursorCompletionMeta;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  usage?: OpenAIUsage;
  cursor?: CursorCompletionMeta;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: "stop" | "tool_calls" | "length" | null;
  }>;
}

export interface CursorModelParameterDefinition {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
}

export interface CursorModelVariant {
  params: Array<{ id: string; value: string }>;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  display_name?: string;
  description?: string;
  cursor_aliases?: string[];
  cursor_parameters?: CursorModelParameterDefinition[];
  cursor_variants?: CursorModelVariant[];
  /** Base Cursor catalog id when this row is a proxy `*-slow` / `*-fast` alias. */
  cursor_base_model?: string;
  cursor_speed_alias?: "slow" | "fast";
  /** Params applied by the alias unless overridden via `cursor_model_params`. */
  cursor_model_params?: Array<{ id: string; value: string }>;
};

export interface ModelsListResponse {
  object: "list";
  data: OpenAIModel[];
}

export function makeCompletionId(): string {
  return makeId("chatcmpl", "-");
}
