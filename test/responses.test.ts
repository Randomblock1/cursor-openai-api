import { describe, expect, test } from "bun:test";
import type { ChatCompletionResponse } from "../src/openai.js";
import {
  ResponsesStreamTranslator,
  chatCompletionToResponse,
  responsesInputToMessages,
  responsesRequestSchema,
  responsesToChatRequest,
} from "../src/responses.js";

describe("responsesRequestSchema", () => {
  test("accepts string input", () => {
    const parsed = responsesRequestSchema.safeParse({
      input: "Hello",
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts message array input", () => {
    const parsed = responsesRequestSchema.safeParse({
      input: [
        { role: "developer", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects empty input without instructions", () => {
    const parsed = responsesRequestSchema.safeParse({ input: "" });
    expect(parsed.success).toBe(false);
  });
});

describe("responsesToChatRequest", () => {
  test("maps flat responses tools to nested chat tools", () => {
    const chat = responsesToChatRequest({
      input: "Hi",
      tools: [
        {
          type: "function",
          name: "echo",
          description: "Echo it",
          parameters: { type: "object", properties: {} },
        },
      ],
      tool_choice: { type: "function", name: "echo" },
    });
    expect(chat.tools).toEqual([
      {
        type: "function",
        function: {
          name: "echo",
          description: "Echo it",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(chat.tool_choice).toEqual({
      type: "function",
      function: { name: "echo" },
    });
  });

  test("rejects non-function responses tools", () => {
    expect(() =>
      responsesToChatRequest({
        input: "Hi",
        tools: [{ type: "web_search" }],
      }),
    ).toThrow(/function tools/);
  });

  test("maps instructions and string input", () => {
    const chat = responsesToChatRequest({
      model: "composer-2",
      instructions: "You are helpful.",
      input: "Hello",
      stream: false,
    });
    expect(chat.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ]);
    expect(chat.model).toBe("composer-2");
    expect(chat.max_tokens).toBeUndefined();
  });

  test("maps developer role to system", () => {
    const messages = responsesInputToMessages([
      { role: "developer", content: "Rules" },
      { role: "user", content: "Go" },
    ]);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
  });

  test("maps reasoning effort and max_output_tokens", () => {
    const chat = responsesToChatRequest({
      input: "Hi",
      max_output_tokens: 128,
      reasoning: { effort: "high" },
      stream: true,
    });
    expect(chat.reasoning_effort).toBe("high");
    expect(chat.max_tokens).toBe(128);
    expect(chat.stream).toBe(true);
  });

  test("maps function_call_output to tool message", () => {
    const messages = responsesInputToMessages([
      {
        type: "function_call_output",
        call_id: "call_abc",
        output: '{"ok":true}',
      },
    ]);
    expect(messages[0]).toEqual({
      role: "tool",
      content: '{"ok":true}',
      tool_call_id: "call_abc",
    });
  });

  test("maps function_call to assistant tool_calls", () => {
    const messages = responsesInputToMessages([
      {
        type: "function_call",
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
    ]);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.tool_calls?.[0]?.function.name).toBe("get_weather");
  });

  test("preserves image_url content parts", () => {
    const messages = responsesInputToMessages([
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/a.png" },
          },
        ],
      },
    ]);
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    const parts = messages[0]?.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });
});

describe("chatCompletionToResponse", () => {
  test("builds message and reasoning output items", () => {
    const completion: ChatCompletionResponse = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "composer-2.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Done.",
            reasoning_content: "Thinking...",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    };

    const response = chatCompletionToResponse(completion, {
      input: "Hi",
      instructions: "Help",
      stream: false,
    });

    expect(response.object).toBe("response");
    expect(response.status).toBe("completed");
    expect(response.instructions).toBe("Help");
    expect(response.output[0]?.type).toBe("reasoning");
    expect(response.output.at(-1)?.type).toBe("message");
    expect(response.usage?.input_tokens).toBe(10);
    expect(response.usage?.output_tokens_details?.reasoning_tokens).toBe(2);
  });
});

describe("ResponsesStreamTranslator", () => {
  test("emits response lifecycle and text deltas", async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const translator = new ResponsesStreamTranslator(
      { input: "Hi", stream: true },
      "composer-2",
      async (event, data) => {
        events.push({ event, data });
      },
    );

    await translator.handleChatChunk({
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      created: 1,
      model: "composer-2",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    await translator.handleChatChunk({
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      created: 1,
      model: "composer-2",
      choices: [
        { index: 0, delta: { content: "Hello" }, finish_reason: null },
      ],
    });
    await translator.finish();

    const types = events.map((e) => e.data.type);
    expect(types).toContain("response.created");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.completed");
    const completed = events.find((e) => e.data.type === "response.completed");
    const response = completed?.data.response as { output: Array<{ type: string }> };
    expect(response.output.some((o) => o.type === "message")).toBe(true);
  });

  test("finish emits lifecycle for empty stream", async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const translator = new ResponsesStreamTranslator(
      { input: "Hi", stream: true },
      "composer-2",
      async (event, data) => {
        events.push({ event, data });
      },
    );
    await translator.emitLifecycleStart();
    await translator.finish();
    const types = events.map((e) => e.data.type);
    expect(types).toContain("response.created");
    expect(types).toContain("response.completed");
  });

  test("streams tool call arguments once into completed output", async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const translator = new ResponsesStreamTranslator(
      { input: "Hi", stream: true },
      "composer-2",
      async (event, data) => {
        events.push({ event, data });
      },
    );

    await translator.handleChatChunk({
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      created: 1,
      model: "composer-2",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: '{"query":"docs"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    await translator.finish();

    const argDeltas = events
      .filter((e) => e.data.type === "response.function_call_arguments.delta")
      .map((e) => e.data.delta);
    expect(argDeltas).toEqual(['{"query":"docs"}']);

    const completed = events.find((e) => e.data.type === "response.completed");
    const response = completed?.data.response as {
      output: Array<{ type: string; arguments?: string }>;
    };
    const call = response.output.find((item) => item.type === "function_call");
    expect(call?.arguments).toBe('{"query":"docs"}');
  });
});
