import { describe, expect, test } from "bun:test";
import type { ClientToolSpec } from "../src/client-tools/types.js";
import { chunksFromInteractionUpdate } from "../src/interaction-delta.js";
import { createStreamState } from "../src/stream.js";
import type { TurnPolicy } from "../src/turn-policy.js";
import {
  defaultAssistantTextStream,
  type TurnStreamContext,
} from "../src/turn-stream.js";

// Client tools now reach the model via SDK customTools and are captured by the
// bridge in agent-turn.ts — the streaming text path no longer parses markers.
// On a client-tool turn the assistant text streams through the default stream
// untouched (model prose), so the only difference vs a plain turn is that
// clientToolSpecs is populated.
function streamContext(policy: TurnPolicy, specs?: ClientToolSpec[]): TurnStreamContext {
  if (!specs?.length) {
    return { policy, assistantText: defaultAssistantTextStream() };
  }
  return {
    policy,
    clientToolSpecs: specs,
    assistantText: defaultAssistantTextStream(),
  };
}

const livePolicy: TurnPolicy = {
  includeThinking: true,
  emitCursorTools: false,
  clientToolLoop: false,
  debugStream: false,
  assistantTextMode: "live",
};

const finalContentPolicy: TurnPolicy = {
  ...livePolicy,
  assistantTextMode: "final-content",
};

const preamblePolicy: TurnPolicy = {
  ...livePolicy,
  assistantTextMode: "preamble-as-reasoning",
};

const withCursorTools: TurnPolicy = {
  includeThinking: false,
  emitCursorTools: true,
  clientToolLoop: false,
  debugStream: false,
  assistantTextMode: "final-content",
};

const clientToolPreambleStream = streamContext(
  {
    includeThinking: true,
    emitCursorTools: false,
    clientToolLoop: true,
    debugStream: false,
    assistantTextMode: "preamble-as-reasoning",
  },
  [{ name: "glob", parameters: { type: "object", properties: {} } }],
);

const clientToolLiveStream = streamContext(
  {
    includeThinking: true,
    emitCursorTools: false,
    clientToolLoop: true,
    debugStream: false,
    assistantTextMode: "live",
  },
  [{ name: "glob", parameters: { type: "object", properties: {} } }],
);

const clientToolEchoStream = streamContext(
  {
    includeThinking: false,
    emitCursorTools: false,
    clientToolLoop: true,
    debugStream: false,
    assistantTextMode: "live",
  },
  [{ name: "echo" }],
);

function collectInterleavedTurn(
  policy: TurnPolicy,
): ChatCompletionChunkLike[] {
  const state = createStreamState("composer-2");
  const stream = streamContext(policy);
  const chunks: ChatCompletionChunkLike[] = [];

  for (const chunk of chunksFromInteractionUpdate(
    { type: "thinking-delta", text: "think A" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunksFromInteractionUpdate(
    { type: "text-delta", text: "early text" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunksFromInteractionUpdate(
    { type: "thinking-delta", text: "think B" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunksFromInteractionUpdate(
    { type: "text-delta", text: "final text" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunksFromInteractionUpdate(
    { type: "turn-ended" },
    state,
    stream,
  )) {
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

type ChatCompletionChunkLike = {
  choices: Array<{
    delta: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{ function?: { name?: string } }>;
    };
  }>;
};

describe("chunksFromInteractionUpdate", () => {
  test("live mode streams text-delta immediately", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "Hello" },
        state,
        streamContext(livePolicy),
      ),
    ];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.choices[0]?.delta.content).toBe("Hello");
    expect(state.text).toBe("Hello");
    expect(state.pendingText).toBe("");
  });

  test("maps thinking-delta when enabled", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        { type: "thinking-delta", text: "plan" },
        state,
        streamContext(preamblePolicy),
      ),
    ];
    expect(chunks[0]?.choices[0]?.delta.reasoning_content).toBe("plan");
  });

  test("live mode interleaved turn streams content as it arrives", () => {
    const chunks = collectInterleavedTurn(livePolicy);
    const contents = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter(Boolean);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter(Boolean);

    expect(reasoning).toEqual(["think A", "think B"]);
    expect(contents).toEqual(["early text", "final text"]);
  });

  test("final-content mode emits one content chunk at turn-end", () => {
    const chunks = collectInterleavedTurn(finalContentPolicy);
    const contents = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter(Boolean);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter(Boolean);

    expect(reasoning).toEqual(["think A", "think B"]);
    expect(contents).toEqual(["early textfinal text"]);
  });

  test("preamble-as-reasoning re-routes early text before later thinking", () => {
    const chunks = collectInterleavedTurn(preamblePolicy);
    const contents = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter(Boolean);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter(Boolean);

    expect(reasoning).toEqual(["think A", "early text", "think B"]);
    expect(contents).toEqual(["final text"]);
  });

  test("emits buffered text as content at turn-end when only text in turn", () => {
    const state = createStreamState("composer-2");
    const stream = streamContext(finalContentPolicy);

    expect([
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "Only response." },
        state,
        stream,
      ),
    ]).toHaveLength(0);

    const flushed = [
      ...chunksFromInteractionUpdate({ type: "turn-ended" }, state, stream),
    ];
    expect(flushed[0]?.choices[0]?.delta.content).toBe("Only response.");
  });

  test("final-content buffers text when only cursor tool-calls are enabled", () => {
    const state = createStreamState("composer-2");

    expect([
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "Calling tool." },
        state,
        streamContext(withCursorTools),
      ),
    ]).toHaveLength(0);

    const tool = [
      ...chunksFromInteractionUpdate(
        {
          type: "tool-call-started",
          callId: "call-1",
          toolName: "search",
        } as never,
        state,
        streamContext(withCursorTools),
      ),
    ];
    expect(tool[0]?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe(
      "search",
    );
    expect(state.pendingText).toBe("Calling tool.");

    const flushed = [
      ...chunksFromInteractionUpdate(
        { type: "turn-ended" },
        state,
        streamContext(withCursorTools),
      ),
    ];
    expect(flushed[0]?.choices[0]?.delta.content).toBe("Calling tool.");
  });

  test("client tool loop respects preamble-as-reasoning for visible text", () => {
    const state = createStreamState("composer-2");
    const stream = clientToolPreambleStream;

    expect([
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "I'll check.\n" },
        state,
        stream,
      ),
    ]).toHaveLength(0);
    expect(state.pendingText).toBe("I'll check.\n");

    const reasoning = [
      ...chunksFromInteractionUpdate(
        { type: "thinking-delta", text: "planning" },
        state,
        stream,
      ),
    ];
    expect(reasoning[0]?.choices[0]?.delta.reasoning_content).toBe(
      "I'll check.\n",
    );
    expect(reasoning[1]?.choices[0]?.delta.reasoning_content).toBe("planning");
  });

  test("client tool loop streams model prose untouched (no marker parsing)", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        { type: "text-delta", text: "Calling a tool now." },
        state,
        clientToolLiveStream,
      ),
    ];

    // Text streams straight through; tool calls are captured by the bridge, not
    // parsed from the text stream, so no tool_calls appear here.
    expect(chunks[0]?.choices[0]?.delta.content).toBe("Calling a tool now.");
    expect(state.toolCalls.size).toBe(0);
  });

  test("suppresses SDK tool-call events in client tool loop", () => {
    const state = createStreamState("composer-2");
    const chunks = [
      ...chunksFromInteractionUpdate(
        {
          type: "tool-call-started",
          callId: "call-1",
          toolName: "Read",
        } as never,
        state,
        clientToolEchoStream,
      ),
    ];
    expect(chunks).toHaveLength(0);
    expect(state.toolCalls.size).toBe(0);
  });
});
