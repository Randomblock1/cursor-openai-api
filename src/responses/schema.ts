import { z } from "zod";
import { contentPartSchema } from "../content-part-schema.js";
import { makeId } from "../ids.js";
import { modelParameterValueSchema } from "../openai.js";

const inputItemSchema = z
  .object({
    type: z.string().optional(),
    role: z.enum(["system", "user", "assistant", "developer", "tool"]).optional(),
    content: z
      .union([z.string(), z.array(contentPartSchema)])
      .optional(),
    call_id: z.string().optional(),
    output: z.union([z.string(), z.array(contentPartSchema)]).optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
  })
  .passthrough();

export const responsesRequestSchema = z
  .object({
    model: z.string().optional(),
    input: z.union([z.string(), z.array(inputItemSchema)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_output_tokens: z.number().optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    user: z.string().optional(),
    reasoning: z
      .object({
        effort: z.string().optional(),
        summary: z.string().optional(),
      })
      .passthrough()
      .optional(),
    cursor_model_params: z.array(modelParameterValueSchema).optional(),
    cursor_include_thinking: z.boolean().optional(),
    previous_response_id: z.string().nullish(),
    store: z.boolean().optional(),
    parallel_tool_calls: z.boolean().optional(),
    truncation: z.string().optional(),
    text: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (typeof data.input === "string") {
      if (!data.input.trim() && !data.instructions?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "input must be non-empty when instructions are omitted",
          path: ["input"],
        });
      }
      return;
    }
    if (data.input.length === 0 && !data.instructions?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "input must contain at least one item when instructions are omitted",
        path: ["input"],
      });
    }
  });

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type ResponsesInputItem = z.infer<typeof inputItemSchema>;

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

export interface ResponseOutputTextPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface ResponseMessageItem {
  id: string;
  type: "message";
  status: "in_progress" | "completed" | "incomplete";
  role: "assistant";
  content: ResponseOutputTextPart[];
}

export interface ResponseReasoningItem {
  id: string;
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
}

export interface ResponseFunctionCallItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
}

export type ResponseOutputItem =
  | ResponseMessageItem
  | ResponseReasoningItem
  | ResponseFunctionCallItem;

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  model: string;
  output: ResponseOutputItem[];
  instructions: string | null;
  error: null;
  incomplete_details: null;
  max_output_tokens: number | null;
  parallel_tool_calls: boolean;
  previous_response_id: null;
  reasoning: { effort: string | null; summary: string | null };
  store: boolean;
  temperature: number | null;
  text: { format: { type: "text" } };
  tool_choice: string | Record<string, unknown>;
  tools: unknown[];
  top_p: number | null;
  truncation: string;
  usage: ResponsesUsage | null;
  user: string | null;
  metadata: Record<string, string>;
}

export const makeResponseId = (): string => makeId("resp");
export const makeMessageItemId = (): string => makeId("msg");
export const makeReasoningItemId = (): string => makeId("rs");
export const makeFunctionCallItemId = (): string => makeId("fc");
