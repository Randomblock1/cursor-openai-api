import { afterEach, describe, expect, test } from "bun:test";
import type { InteractionUpdate, SDKAgent } from "@cursor/sdk";
import { executeAgentTurn } from "../src/agent-turn.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatMessage } from "../src/openai.js";
import { createProxyContext, type ProxyContext } from "../src/proxy-context.js";
import { testProxyConfig } from "./helpers/test-config.js";

interface FakeSend {
  payload: unknown;
  options: {
    onDelta: (args: { update: InteractionUpdate }) => Promise<void>;
    local?: { customTools?: Record<string, FakeCustomTool> };
  };
  run: FakeRun;
}

interface FakeCustomTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: { toolCallId?: string },
  ) => unknown;
}

interface FakeRun {
  id: string;
  agentId: string;
  status: string;
  supports: (op: string) => boolean;
  stream: () => AsyncGenerator<unknown, void>;
  wait: () => Promise<{ id: string; status: string; result?: string }>;
  cancel: () => Promise<void>;
  cancelled: boolean;
}

function createFakeAgent(agentId = "agent-1") {
  const sends: FakeSend[] = [];
  let runCounter = 0;

  const agent = {
    agentId,
    send: async (payload: unknown, options: FakeSend["options"]) => {
      runCounter += 1;
      const id = `run-${runCounter}`;
      let releaseStream!: () => void;
      const streamClosed = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let resolveWait!: (result: { id: string; status: string; result?: string }) => void;
      const waited = new Promise<{ id: string; status: string; result?: string }>(
        (resolve) => {
          resolveWait = resolve;
        },
      );

      const run: FakeRun = {
        id,
        agentId,
        status: "running",
        cancelled: false,
        supports: () => true,
        stream: async function* () {
          await streamClosed;
        },
        wait: () => waited,
        cancel: async () => {
          run.cancelled = true;
          run.status = "cancelled";
          releaseStream();
          resolveWait({ id, status: "cancelled" });
        },
      };

      const send: FakeSend & {
        finish: (result: string) => void;
      } = {
        payload,
        options,
        run,
      } as never;
      Reflect.set(send, "finish", (result: string) => {
        run.status = "finished";
        releaseStream();
        resolveWait({ id, status: "finished", result });
      });
      sends.push(send);
      return run;
    },
    close() {},
    [Symbol.asyncDispose]: async () => {},
  } as unknown as SDKAgent;

  return {
    agent,
    sends,
    lastSend: () => sends[sends.length - 1]!,
    emit: (update: InteractionUpdate) =>
      sends[sends.length - 1]!.options.onDelta({ update }),
    finish: (result: string) =>
      (sends[sends.length - 1] as never as { finish: (r: string) => void }).finish(
        result,
      ),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

function seedSession(proxy: ProxyContext, agent: SDKAgent, agentId: string) {
  proxy.sessions.registerTestSession("auto:test-seed", {
    agent,
    agentId,
    modelId: "composer-2.5",
    messageCount: 0,
    messagesSnapshot: [],
    lastAccess: Date.now(),
  });
}

function toolRequest(
  messages: ChatMessage[],
  stream = false,
): ChatCompletionRequest {
  return {
    model: "composer-2.5",
    messages,
    stream,
    tools: [weatherTool],
  };
}

const contexts: ProxyContext[] = [];

function makeProxy(overrides = {}) {
  const proxy = createProxyContext(
    testProxyConfig({ CURSOR_INCLUDE_THINKING: false, ...overrides }),
  );
  contexts.push(proxy);
  return proxy;
}

afterEach(async () => {
  for (const proxy of contexts.splice(0)) {
    await proxy.toolBridges.clear();
    proxy.sessions.clearForTests();
  }
});

describe("native client tool loop", () => {
  test("pauses with tool_calls, resumes with results, completes the run", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const userMessage: ChatMessage = { role: "user", content: "Weather in NYC?" };
    const chunks: Array<ChatCompletionChunk | "[DONE]"> = [];

    const firstTurn = executeAgentTurn(
      { proxy, request: toolRequest([userMessage], true) },
      { stream: { write: async (chunk) => void chunks.push(chunk) } },
    );

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    expect(customTools?.get_weather).toBeDefined();
    expect(customTools?.get_weather?.inputSchema).toEqual(
      weatherTool.function.parameters,
    );

    await fake.emit({ type: "text-delta", text: "Checking now. " } as never);

    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      { toolCallId: "sdk-tool-1" },
    ) as Promise<unknown>;

    const outcome1 = await firstTurn;
    expect(outcome1.state.toolCalls.size).toBe(1);
    const emitted = [...outcome1.state.toolCalls.values()][0]!;
    expect(emitted.name).toBe("get_weather");
    expect(emitted.arguments).toBe('{"city":"NYC"}');

    const finishChunk = chunks.findLast(
      (chunk): chunk is ChatCompletionChunk => chunk !== "[DONE]",
    );
    expect(finishChunk?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(chunks.at(-1)).toBe("[DONE]");

    // The run is parked, not cancelled, and the session was committed.
    expect(proxy.toolBridges.size()).toBe(1);
    expect(fake.lastSend().run.cancelled).toBe(false);
    expect(outcome1.prepared.sessionKey).toBeDefined();

    // Client executes the tool and posts the follow-up.
    const followUp: ChatMessage[] = [
      userMessage,
      {
        role: "assistant",
        content: "Checking now. ",
        tool_calls: [
          {
            id: emitted.id,
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: emitted.id, content: "Sunny, 25C" },
    ];

    const secondTurn = executeAgentTurn({
      proxy,
      request: toolRequest(followUp),
    });

    // The pending execute resolves with the client's tool result.
    expect(await executeResult).toBe("Sunny, 25C");
    // No new send happened — the original run resumed.
    expect(fake.sends.length).toBe(1);
    expect(proxy.toolBridges.size()).toBe(0);

    await fake.emit({ type: "text-delta", text: "It is sunny in NYC." } as never);
    await fake.emit({ type: "turn-ended" } as never);
    fake.finish("It is sunny in NYC.");

    const outcome2 = await secondTurn;
    expect(outcome2.finalText).toBe("It is sunny in NYC.");
    expect(outcome2.state.text).toBe("It is sunny in NYC.");
    expect(outcome2.state.toolCalls.size).toBe(0);
  });

  test("aborts the parked run when the follow-up is not a tool-result delta", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const userMessage: ChatMessage = { role: "user", content: "Weather in NYC?" };
    const firstTurn = executeAgentTurn({
      proxy,
      request: toolRequest([userMessage]),
    });

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      {},
    ) as Promise<unknown>;

    const outcome1 = await firstTurn;
    const emitted = [...outcome1.state.toolCalls.values()][0]!;
    const firstRun = fake.lastSend().run;

    // Client ignores the tool call and asks something new instead.
    const followUp: ChatMessage[] = [
      userMessage,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: emitted.id,
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: emitted.id, content: "Sunny" },
      { role: "user", content: "Actually, tell me a joke." },
    ];

    const secondTurn = executeAgentTurn({
      proxy,
      request: toolRequest(followUp),
    });

    await waitFor(() => fake.sends.length === 2);
    // Old run was torn down; pending execute settled with an error result.
    expect(firstRun.cancelled).toBe(true);
    expect(await executeResult).toMatchObject({ isError: true });

    // Fresh send replays the unconsumed delta as prompt text.
    const payload = fake.lastSend().payload;
    expect(typeof payload).toBe("string");
    expect(payload as string).toContain("Sunny");
    expect(payload as string).toContain("tell me a joke");

    await fake.emit({ type: "text-delta", text: "Here's a joke." } as never);
    await fake.emit({ type: "turn-ended" } as never);
    fake.finish("Here's a joke.");

    const outcome2 = await secondTurn;
    expect(outcome2.finalText).toBe("Here's a joke.");
  });

  test("re-presents unanswered calls when the client returns partial results", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const userMessage: ChatMessage = {
      role: "user",
      content: "Weather in NYC and LA?",
    };
    const firstTurn = executeAgentTurn({
      proxy,
      request: toolRequest([userMessage]),
    });

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const nycResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      { toolCallId: "a" },
    ) as Promise<unknown>;
    const laResult = customTools!.get_weather!.execute(
      { city: "LA" },
      { toolCallId: "b" },
    ) as Promise<unknown>;

    const outcome1 = await firstTurn;
    expect(outcome1.state.toolCalls.size).toBe(2);
    const [nycCall, laCall] = [...outcome1.state.toolCalls.values()];

    // Follow-up carries only the NYC result.
    const followUp: ChatMessage[] = [
      userMessage,
      { role: "tool", tool_call_id: nycCall!.id, content: "Sunny" },
    ];

    const outcome2 = await executeAgentTurn({
      proxy,
      request: toolRequest(followUp),
    });

    expect(await nycResult).toBe("Sunny");
    // The LA call is re-presented and the response pauses again.
    expect(outcome2.state.toolCalls.size).toBe(1);
    expect([...outcome2.state.toolCalls.values()][0]?.id).toBe(laCall!.id);
    expect(proxy.toolBridges.size()).toBe(1);

    // Third leg supplies the LA result and the run completes.
    const thirdTurn = executeAgentTurn({
      proxy,
      request: toolRequest([
        ...followUp,
        { role: "tool", tool_call_id: laCall!.id, content: "Cloudy" },
      ]),
    });

    expect(await laResult).toBe("Cloudy");
    await fake.emit({ type: "turn-ended" } as never);
    fake.finish("NYC sunny, LA cloudy.");

    const outcome3 = await thirdTurn;
    expect(outcome3.finalText).toBe("NYC sunny, LA cloudy.");
  });

  test("cancels the parked run when the tool-result timeout elapses", async () => {
    const proxy = makeProxy({ CURSOR_TOOL_RESULT_TIMEOUT_MS: 30 });
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const firstTurn = executeAgentTurn({
      proxy,
      request: toolRequest([{ role: "user", content: "Weather in NYC?" }]),
    });

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      {},
    ) as Promise<unknown>;

    await firstTurn;
    expect(proxy.toolBridges.size()).toBe(1);

    await waitFor(() => proxy.toolBridges.size() === 0);
    expect(await executeResult).toMatchObject({ isError: true });
    expect(fake.lastSend().run.cancelled).toBe(true);
  });

  test("stateless mode (sessions disabled) settles executes and cancels the run", async () => {
    const proxy = makeProxy({ CURSOR_ENABLE_SESSIONS: false });
    const fake = createFakeAgent();

    const turn = executeAgentTurn({
      proxy,
      request: toolRequest([{ role: "user", content: "Weather in NYC?" }]),
      createAgent: async () => fake.agent,
    });

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      {},
    ) as Promise<unknown>;

    const outcome = await turn;
    // The response still reports the tool call…
    expect(outcome.state.toolCalls.size).toBe(1);
    // …but nothing is parked: the execute settles with an error and the run
    // is cancelled; the follow-up will replay results as prompt text.
    expect(proxy.toolBridges.size()).toBe(0);
    expect(await executeResult).toMatchObject({ isError: true });
    await waitFor(() => fake.lastSend().run.cancelled);
  });

  test("session eviction tears down the parked bridge", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const firstTurn = executeAgentTurn({
      proxy,
      request: toolRequest([{ role: "user", content: "Weather in NYC?" }]),
    });
    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      {},
    ) as Promise<unknown>;
    await firstTurn;
    expect(proxy.toolBridges.size()).toBe(1);

    proxy.sessions.clearForTests();

    expect(proxy.toolBridges.size()).toBe(0);
    expect(await executeResult).toMatchObject({ isError: true });
    await waitFor(() => fake.lastSend().run.cancelled);
  });

  test("does not register custom tools when the request has none", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const turn = executeAgentTurn({
      proxy,
      request: {
        model: "composer-2.5",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    await waitFor(() => fake.sends.length === 1);
    expect(fake.lastSend().options.local).toBeUndefined();

    await fake.emit({ type: "text-delta", text: "hi" } as never);
    await fake.emit({ type: "turn-ended" } as never);
    fake.finish("hi");
    const outcome = await turn;
    expect(outcome.finalText).toBe("hi");
  });
});
