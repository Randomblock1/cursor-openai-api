import { describe, expect, test } from "bun:test";
import { planBridgeResume } from "../../src/client-tools/results.js";
import type { ChatMessage } from "../../src/openai.js";

const pending = new Set(["call_1", "call_2"]);

const echo: ChatMessage = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"NYC"}' },
    },
  ],
};

describe("planBridgeResume", () => {
  test("accepts assistant echo plus tool results for pending ids", () => {
    const plan = planBridgeResume(
      [echo, { role: "tool", tool_call_id: "call_1", content: "Sunny" }],
      pending,
    );
    expect(plan?.results).toEqual([{ id: "call_1", text: "Sunny" }]);
  });

  test("accepts tool results without the assistant echo", () => {
    const plan = planBridgeResume(
      [{ role: "tool", tool_call_id: "call_2", content: "ok" }],
      pending,
    );
    expect(plan?.results).toEqual([{ id: "call_2", text: "ok" }]);
  });

  test("flattens content-part arrays to text", () => {
    const plan = planBridgeResume(
      [
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: "part" }, { type: "text", text: "two" }],
        },
      ],
      pending,
    );
    expect(plan?.results[0]?.text).toBe("part\ntwo");
  });

  test("rejects deltas containing user messages", () => {
    const plan = planBridgeResume(
      [
        echo,
        { role: "tool", tool_call_id: "call_1", content: "Sunny" },
        { role: "user", content: "also check LA" },
      ],
      pending,
    );
    expect(plan).toBeUndefined();
  });

  test("rejects tool results for unknown call ids", () => {
    const plan = planBridgeResume(
      [{ role: "tool", tool_call_id: "call_9", content: "??" }],
      pending,
    );
    expect(plan).toBeUndefined();
  });

  test("skips assistant echo messages without tool_calls (responses clients)", () => {
    // /v1/responses clients echo the paused text and an empty message item as
    // separate assistant messages, distinct from the function_call echoes.
    const plan = planBridgeResume(
      [
        { role: "assistant", content: "Checking now." },
        { role: "assistant", content: "" },
        echo,
        { role: "tool", tool_call_id: "call_1", content: "Sunny" },
      ],
      pending,
    );
    expect(plan?.results).toEqual([{ id: "call_1", text: "Sunny" }]);
  });

  test("rejects assistant echoes carrying unknown tool call ids", () => {
    const plan = planBridgeResume(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_other",
              type: "function",
              function: { name: "x", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "Sunny" },
      ],
      pending,
    );
    expect(plan).toBeUndefined();
  });

  test("rejects empty deltas", () => {
    expect(planBridgeResume([], pending)).toBeUndefined();
    expect(planBridgeResume([echo], pending)).toBeUndefined();
  });

  test("last duplicate result wins", () => {
    const plan = planBridgeResume(
      [
        { role: "tool", tool_call_id: "call_1", content: "first" },
        { role: "tool", tool_call_id: "call_1", content: "second" },
      ],
      pending,
    );
    expect(plan?.results).toEqual([{ id: "call_1", text: "second" }]);
  });
});
