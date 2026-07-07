import { z } from "zod";
import { contentToText } from "../content-parts.js";
import { ProxyError } from "../errors.js";
import { normalizeChatMetadata } from "../metadata.js";
import type { ChatCompletionRequest, ChatMessage } from "../openai.js";
import { chatMessageSchema } from "../openai.js";
import type { ResponsesInputItem, ResponsesRequest } from "./schema.js";

function mapResponsesRole(
  role: "system" | "user" | "assistant" | "developer" | "tool",
): ChatMessage["role"] {
  if (role === "developer") return "system";
  if (role === "tool") return "tool";
  return role;
}

function preserveMessageContent(
  content: ResponsesInputItem["content"],
): ChatMessage["content"] {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content;
  }
  throw new ProxyError(
    "Invalid message content in responses input",
    400,
    "invalid_request_error",
    "invalid_input_content",
  );
}

function inputItemToMessages(item: ResponsesInputItem): ChatMessage[] {
  const itemType = item.type;

  // Clients following the documented `input = input.concat(response.output)`
  // loop echo reasoning output items back; they carry no replayable content.
  if (itemType === "reasoning") {
    return [];
  }

  if (itemType === "function_call_output") {
    if (!item.call_id?.trim()) {
      throw new ProxyError(
        "function_call_output requires call_id",
        400,
        "invalid_request_error",
        "invalid_function_call_output",
      );
    }
    const output =
      typeof item.output === "string"
        ? item.output
        : contentToText(preserveMessageContent(item.output));
    return [{ role: "tool", content: output, tool_call_id: item.call_id }];
  }

  if (itemType === "function_call") {
    if (!item.call_id?.trim() || !item.name?.trim()) {
      throw new ProxyError(
        "function_call requires call_id and name",
        400,
        "invalid_request_error",
        "invalid_function_call",
      );
    }
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments ?? "{}",
            },
          },
        ],
      },
    ];
  }

  if (itemType === "message") {
    const role = mapResponsesRole(item.role ?? "user");
    return [{ role, content: preserveMessageContent(item.content) }];
  }

  if (itemType === undefined && item.role) {
    const role = mapResponsesRole(item.role);
    return [{ role, content: preserveMessageContent(item.content) }];
  }

  if (itemType === undefined && (typeof item.content === "string" || Array.isArray(item.content))) {
    return [{ role: "user", content: preserveMessageContent(item.content) }];
  }

  throw new ProxyError(
    `Unsupported or malformed responses input item: ${itemType ?? "unknown"}`,
    400,
    "invalid_request_error",
    "invalid_input_item",
  );
}

export function responsesInputToMessages(
  input: ResponsesRequest["input"],
): ChatMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  const messages: ChatMessage[] = [];
  for (const item of input) {
    messages.push(...inputItemToMessages(item));
  }
  return messages;
}

/**
 * Responses tools are flat (`{type:"function", name, parameters}`); chat
 * completions nest the function fields. Convert so both endpoints share the
 * native customTools path.
 */
function responsesToolsToChatTools(
  tools: ResponsesRequest["tools"],
): ChatCompletionRequest["tools"] {
  if (!tools?.length) return undefined;
  return tools.map((tool, index) => {
    if (tool.type !== "function" || typeof tool.name !== "string") {
      throw new ProxyError(
        `Only function tools are supported: tools[${index}]`,
        400,
        "invalid_request_error",
        `tools[${index}]`,
      );
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string"
          ? { description: tool.description }
          : {}),
        ...(tool.parameters !== undefined
          ? { parameters: tool.parameters }
          : {}),
      },
    };
  });
}

function responsesToolChoiceToChat(
  toolChoice: unknown,
): ChatCompletionRequest["tool_choice"] {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (
    typeof toolChoice === "object" &&
    Reflect.get(toolChoice, "type") === "function" &&
    typeof Reflect.get(toolChoice, "name") === "string"
  ) {
    return {
      type: "function",
      function: { name: Reflect.get(toolChoice, "name") },
    };
  }
  return toolChoice as ChatCompletionRequest["tool_choice"];
}

export function responsesToChatRequest(
  request: ResponsesRequest,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  if (request.instructions?.trim()) {
    messages.push({ role: "system", content: request.instructions });
  }

  messages.push(...responsesInputToMessages(request.input));

  const parsedMessages = z.array(chatMessageSchema).min(1).parse(messages);

  return {
    model: request.model,
    messages: parsedMessages,
    stream: request.stream,
    temperature: request.temperature,
    top_p: request.top_p,
    max_tokens: request.max_output_tokens,
    tools: responsesToolsToChatTools(request.tools),
    tool_choice: responsesToolChoiceToChat(request.tool_choice),
    metadata: normalizeChatMetadata(request.metadata),
    user: request.user,
    reasoning_effort: request.reasoning?.effort,
    cursor_model_params: request.cursor_model_params,
    cursor_include_thinking: request.cursor_include_thinking,
  };
}
