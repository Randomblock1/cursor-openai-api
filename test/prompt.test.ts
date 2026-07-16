import { describe, expect, test } from "bun:test";
import { buildSendPayload } from "../src/messages.js";
import { serializeMessagesToPrompt } from "../src/prompt.js";

describe("serializeMessagesToPrompt", () => {
  test("formats system and user messages", () => {
    const prompt = serializeMessagesToPrompt([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ]);
    expect(prompt).toContain("## SYSTEM");
    expect(prompt).toContain("Be concise.");
    expect(prompt).toContain("## USER");
    expect(prompt).toContain("Hello");
  });

  test("formats assistant reasoning_content for multi-turn", () => {
    const prompt = serializeMessagesToPrompt([
      {
        role: "assistant",
        content: "Answer.",
        reasoning_content: "Internal plan.",
      },
    ]);
    expect(prompt).toContain("reasoning_content:");
    expect(prompt).toContain("Internal plan.");
    expect(prompt).toContain("Answer.");
  });

  test("formats assistant tool_calls", () => {
    const prompt = serializeMessagesToPrompt([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
    ]);
    expect(prompt).toContain("tool_call id=call_1");
    expect(prompt).toContain("get_weather");
  });

  test("buildSendPayload sends plain text for a single user follow-up", () => {
    const payload = buildSendPayload([{ role: "user", content: "What is it?" }]);
    expect(payload).toBe("What is it?");
    expect(payload).not.toContain("## USER");
  });

  test("includes client tools when provided", () => {
    const prompt = serializeMessagesToPrompt([{ role: "user", content: "Hi" }], {
      tools: [{ type: "function", function: { name: "foo" } }],
    });
    expect(prompt).toContain("CLIENT_TOOLS");
    expect(prompt).toContain("foo");
  });

  test("uses client tool loop prompt when specs are provided", () => {
    const prompt = serializeMessagesToPrompt(
      [{ role: "user", content: "Hi" }],
      {
        tools: [{ type: "function", function: { name: "foo" } }],
      },
      [{ name: "foo" }],
    );
    expect(prompt).toContain("custom-user-tools");
    expect(prompt).toContain("Client tools: foo");
    expect(prompt).not.toContain("## CLIENT_TOOLS");
    expect(prompt).not.toContain("tool_calls_begin");
  });

  test("client tool loop prompt carries tool_choice directives", () => {
    const required = serializeMessagesToPrompt(
      [{ role: "user", content: "Hi" }],
      { toolChoice: "required" },
      [{ name: "foo" }],
    );
    expect(required).toContain("must call at least one");

    const named = serializeMessagesToPrompt(
      [{ role: "user", content: "Hi" }],
      { toolChoice: { type: "function", function: { name: "foo" } } },
      [{ name: "foo" }],
    );
    expect(named).toContain("Use the foo tool");
  });

  test("client tool loop prompt serializes tool results for replay", () => {
    const prompt = serializeMessagesToPrompt(
      [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
            },
          ],
        },
        { role: "tool", content: "Sunny", tool_call_id: "call_1" },
      ],
      {},
      [{ name: "get_weather" }],
    );
    expect(prompt).toContain("tool_call id=call_1");
    expect(prompt).toContain("## TOOL");
    expect(prompt).toContain("Sunny");
  });
});
