import { describe, expect, test } from "bun:test";
import { InteractionRelay } from "../../src/client-tools/relay.js";
import type { ChatCompletionChunk } from "../../src/openai.js";
import { createStreamState, type StreamState } from "../../src/stream.js";
import type { TurnPolicy } from "../../src/turn-policy.js";
import {
  defaultAssistantTextStream,
  type TurnStreamContext,
} from "../../src/turn-stream.js";

interface Segment {
  target: {
    state: StreamState;
    stream: TurnStreamContext;
    onChunk: (chunk: ChatCompletionChunk) => Promise<void>;
  };
  state: StreamState;
  chunks: ChatCompletionChunk[];
}

function makeSegment(debugStream = false): Segment {
  const policy: TurnPolicy = {
    includeThinking: true,
    emitCursorTools: false,
    clientToolLoop: true,
    debugStream,
    assistantTextMode: "live",
  };
  const state = createStreamState("composer-2.5");
  const chunks: ChatCompletionChunk[] = [];
  return {
    target: {
      state,
      stream: { policy, assistantText: defaultAssistantTextStream() },
      onChunk: async (chunk) => void chunks.push(chunk),
    },
    state,
    chunks,
  };
}

const textDelta = (text: string) => ({ type: "text-delta", text }) as never;

describe("InteractionRelay", () => {
  test("delivers updates and SDK messages to the attached segment", async () => {
    const relay = new InteractionRelay();
    const segment = makeSegment(true);
    await relay.attach(segment.target);

    await relay.handleUpdate(textDelta("Hello"));
    await relay.handleSdkMessage({
      type: "status",
      status: "working",
      message: "thinking",
    } as never);

    expect(segment.state.text).toBe("Hello\n[status] working: thinking\n");
    expect(segment.chunks.map((c) => c.choices[0]?.delta.content)).toEqual([
      "Hello",
      "\n[status] working: thinking\n",
    ]);
  });

  test("buffers events while detached and replays them in order on attach", async () => {
    const relay = new InteractionRelay();

    await relay.handleUpdate(textDelta("one"));
    await relay.handleSdkMessage({
      type: "status",
      status: "working",
      message: "step",
    } as never);
    await relay.handleUpdate(textDelta("two"));

    const segment = makeSegment(true);
    await relay.attach(segment.target);

    expect(segment.state.text).toBe("one\n[status] working: step\ntwo");
    expect(segment.chunks.map((c) => c.choices[0]?.delta.content)).toEqual([
      "one",
      "\n[status] working: step\n",
      "two",
    ]);
  });

  test("hands off between segments without leaking events across them", async () => {
    const relay = new InteractionRelay();

    const first = makeSegment();
    await relay.attach(first.target);
    await relay.handleUpdate(textDelta("a"));
    await relay.detach();

    // Arrives between segments: buffered, not delivered to the old target.
    await relay.handleUpdate(textDelta("b"));

    const second = makeSegment();
    await relay.attach(second.target);
    await relay.handleUpdate(textDelta("c"));

    expect(first.state.text).toBe("a");
    expect(second.state.text).toBe("bc");
  });

  test("caps the between-segment buffer instead of growing unbounded", async () => {
    const relay = new InteractionRelay();

    const pending: Promise<void>[] = [];
    for (let i = 0; i < 5000; i += 1) {
      pending.push(relay.handleUpdate(textDelta("x")));
    }
    await Promise.all(pending);

    const segment = makeSegment();
    await relay.attach(segment.target);

    // Everything past MAX_BUFFERED_EVENTS (4096) is dropped.
    expect(segment.state.text.length).toBe(4096);
  });
});
