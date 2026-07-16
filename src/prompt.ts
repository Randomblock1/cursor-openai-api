import { contentToText } from "./content-parts.js";
import { parseToolChoice } from "./client-tools/request.js";
import type { ClientToolSpec } from "./client-tools/types.js";
import type { ChatMessage } from "./openai.js";
import type { PromptExtras } from "./messages.js";

const CLIENT_TOOLS_DIRECTIVE = [
  "You are serving an OpenAI-compatible API request through a proxy.",
  'The API client registered the tools listed below. They are available to you as native tools on the "custom-user-tools" MCP server; the client executes each call and returns the result.',
  "Prefer these client tools over your built-in file, search, and shell tools whenever they can accomplish the request, and do not modify workspace files unless the user explicitly asks you to.",
  "Never claim a listed tool is unavailable, and never describe a tool call in prose instead of calling it.",
  "Tool results from earlier turns may appear in the conversation below as `## TOOL` messages.",
].join("\n");

function clientToolChoiceLines(
  toolChoice: PromptExtras["toolChoice"],
): string[] {
  const parsed = parseToolChoice(toolChoice);
  if (parsed === "required") {
    return ["You must call at least one of the client tools before answering."];
  }
  if (typeof parsed === "object" && parsed.type === "function") {
    return [`Use the ${parsed.functionName} tool to answer this request.`];
  }
  return [];
}

function buildClientToolSections(
  messages: ChatMessage[],
  specs: ClientToolSpec[],
  toolChoice: PromptExtras["toolChoice"],
): string[] {
  return [
    CLIENT_TOOLS_DIRECTIVE,
    "",
    `Client tools: ${specs.map((spec) => spec.name).join(", ")}`,
    ...clientToolChoiceLines(toolChoice),
    "",
    "Conversation:",
    ...messages.map(formatMessage),
  ];
}

function formatToolCalls(message: ChatMessage): string {
  if (!message.tool_calls?.length) return "";
  const lines = message.tool_calls.map((tc) => {
    const fn = tc.function;
    return `tool_call id=${tc.id} name=${fn.name} arguments=${fn.arguments}`;
  });
  return `\n${lines.join("\n")}`;
}

function formatAssistantReasoning(message: ChatMessage): string {
  const reasoning = message.reasoning_content ?? message.reasoning ?? "";
  if (!reasoning.trim()) return "";
  return `\nreasoning_content:\n${reasoning.trim()}`;
}

function formatMessage(message: ChatMessage): string {
  const role = message.role.toUpperCase();
  const content = contentToText(message.content);
  const name = message.name ? ` (${message.name})` : "";
  const toolCallId = message.tool_call_id
    ? `\ntool_call_id: ${message.tool_call_id}`
    : "";
  const functionCall = message.function_call
    ? `\nfunction_call: ${message.function_call.name}(${message.function_call.arguments})`
    : "";
  const toolCalls = formatToolCalls(message);
  const reasoning =
    message.role === "assistant" ? formatAssistantReasoning(message) : "";
  return `## ${role}${name}\n${content}${reasoning}${toolCallId}${functionCall}${toolCalls}`.trim();
}

export function serializeMessagesToPrompt(
  messages: ChatMessage[],
  extras?: PromptExtras,
  clientToolSpecs?: ClientToolSpec[],
): string {
  if (clientToolSpecs?.length) {
    const sections = buildClientToolSections(
      messages,
      clientToolSpecs,
      extras?.toolChoice,
    );
    return appendPromptOptions(sections, extras, { skipTools: true }).join("\n");
  }

  const sections: string[] = [
    "You are responding through an OpenAI-compatible API proxy. Follow the conversation below.",
    "",
    ...messages.map(formatMessage),
  ];

  return appendPromptOptions(sections, extras).join("\n");
}

function appendPromptOptions(
  sections: string[],
  extras?: PromptExtras,
  options?: { skipTools?: boolean },
): string[] {
  if (!options?.skipTools && extras?.tools?.length) {
    sections.push(
      "",
      "## CLIENT_TOOLS (OpenAI function schemas — best-effort; you may use your own tools)",
      JSON.stringify(extras.tools, null, 2),
    );
  }
  if (extras?.toolChoice != null) {
    sections.push("", `tool_choice: ${JSON.stringify(extras.toolChoice)}`);
  }
  if (extras?.temperature != null) {
    sections.push(`temperature: ${extras.temperature}`);
  }
  if (extras?.topP != null) {
    sections.push(`top_p: ${extras.topP}`);
  }
  if (extras?.maxTokens != null) {
    sections.push(`max_tokens: ${extras.maxTokens}`);
  }
  if (extras?.stop != null) {
    const stop = Array.isArray(extras.stop) ? extras.stop : [extras.stop];
    sections.push(`stop: ${JSON.stringify(stop)}`);
  }
  if (extras?.seed != null) {
    sections.push(`seed: ${extras.seed}`);
  }
  if (extras?.frequencyPenalty != null) {
    sections.push(`frequency_penalty: ${extras.frequencyPenalty}`);
  }
  if (extras?.presencePenalty != null) {
    sections.push(`presence_penalty: ${extras.presencePenalty}`);
  }
  if (extras?.verbosity != null) {
    sections.push(`verbosity: ${extras.verbosity}`);
  }
  if (extras?.responseFormat != null) {
    sections.push(
      "",
      "## RESPONSE_FORMAT",
      JSON.stringify(extras.responseFormat, null, 2),
    );
  }
  if (extras?.passthrough && Object.keys(extras.passthrough).length > 0) {
    sections.push(
      "",
      "## API_PARAMETERS",
      JSON.stringify(extras.passthrough, null, 2),
    );
  }
  return sections;
}
