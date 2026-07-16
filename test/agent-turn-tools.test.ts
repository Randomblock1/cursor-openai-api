import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { InteractionUpdate, SDKAgent } from "@cursor/sdk";
import { executeAgentTurn } from "../src/agent-turn.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatMessage } from "../src/openai.js";
import { createProxyContext, type ProxyContext } from "../src/proxy-context.js";
import { responsesToChatRequest } from "../src/responses.js";
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

interface FakeRunResult {
  id: string;
  status: string;
  result?: string;
  error?: { message: string; code?: string };
}

interface FakeRun {
  id: string;
  agentId: string;
  status: string;
  supports: (op: string) => boolean;
  stream: () => AsyncGenerator<unknown, void>;
  wait: () => Promise<FakeRunResult>;
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
      let resolveWait!: (result: FakeRunResult) => void;
      const waited = new Promise<FakeRunResult>((resolve) => {
        resolveWait = resolve;
      });

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
      // Real SDK runs report failures via `error.message`/`error.code`;
      // `result` stays the success-text field.
      Reflect.set(send, "fail", (message: string, code?: string) => {
        run.status = "error";
        releaseStream();
        resolveWait({
          id,
          status: "error",
          error: { message, ...(code !== undefined ? { code } : {}) },
        });
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
    fail: (message: string, code?: string) =>
      (
        sends[sends.length - 1] as never as {
          fail: (m: string, c?: string) => void;
        }
      ).fail(message, code),
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

  test("falls back to a fresh send when the parked run dies before results arrive", async () => {
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
    expect(proxy.toolBridges.size()).toBe(1);

    // The run dies backend-side while the client is executing the tool.
    fake.fail("backend connection lost");

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(
      (...args: unknown[]) => void warnings.push(args.map(String).join(" ")),
    );
    try {
      // Even a valid tool-result delta cannot resume a dead run.
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
      ];
      const secondTurn = executeAgentTurn({
        proxy,
        request: toolRequest(followUp),
      });

      await waitFor(() => fake.sends.length === 2);
      expect(await executeResult).toMatchObject({ isError: true });
      expect(proxy.toolBridges.size()).toBe(0);

      // Fresh send replays the unconsumed delta as prompt text.
      const payload = fake.lastSend().payload;
      expect(payload as string).toContain("Sunny");

      await fake.emit({ type: "text-delta", text: "It is sunny." } as never);
      await fake.emit({ type: "turn-ended" } as never);
      fake.finish("It is sunny.");
      const outcome2 = await secondTurn;
      expect(outcome2.finalText).toBe("It is sunny.");

      // The lost run is surfaced to the operator, not silently discarded.
      expect(
        warnings.some((line) => line.includes('ended with status "error"')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("maps a run that errors during an active segment to a 502 with the SDK detail", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const turn = executeAgentTurn({
      proxy,
      request: toolRequest([{ role: "user", content: "Weather in NYC?" }]),
    });

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      {},
    ) as Promise<unknown>;

    // The run errors while the segment is still active, before the
    // collect-window pause finishes the response with tool_calls.
    fake.fail("Upstream provider 503", "provider_unavailable");

    await expect(turn).rejects.toMatchObject({
      status: 502,
      code: "provider_unavailable",
      message: "Upstream provider 503",
    });
    // The pending execute was settled and nothing was parked.
    expect(await executeResult).toMatchObject({ isError: true });
    expect(proxy.toolBridges.size()).toBe(0);
  });

  test("maps a run cancelled during an active segment to a 499", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const turn = executeAgentTurn({
      proxy,
      request: toolRequest([{ role: "user", content: "Weather in NYC?" }]),
    });

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      {},
    ) as Promise<unknown>;

    await fake.lastSend().run.cancel();

    await expect(turn).rejects.toMatchObject({
      status: 499,
      message: "Agent run was cancelled",
    });
    expect(await executeResult).toMatchObject({ isError: true });
    expect(proxy.toolBridges.size()).toBe(0);
  });

  test("disposal while the pause response is still streaming tears down the bridge", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const turn = executeAgentTurn(
      {
        proxy,
        request: toolRequest([{ role: "user", content: "Weather in NYC?" }], true),
      },
      {
        stream: {
          write: async (chunk) => {
            // A concurrent request disposes the agent after the session
            // commit but before the response has reached the client.
            if (
              chunk !== "[DONE]" &&
              chunk.choices[0]?.finish_reason === "tool_calls"
            ) {
              proxy.sessions.clearForTests();
            }
          },
        },
      },
    );

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      {},
    ) as Promise<unknown>;

    const outcome = await turn;
    expect(outcome.state.toolCalls.size).toBe(1);

    // The bridge was registered before the final write, so the disposal hook
    // found and aborted it instead of leaving a zombie until the timeout.
    expect(proxy.toolBridges.size()).toBe(0);
    expect(await executeResult).toMatchObject({ isError: true });
    await waitFor(() => fake.lastSend().run.cancelled);
  });

  test("reclaims the parked bridge when the final write fails", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    let bridgesAtFinishWrite = -1;
    const turn = executeAgentTurn(
      {
        proxy,
        request: toolRequest([{ role: "user", content: "Weather in NYC?" }], true),
      },
      {
        stream: {
          write: async (chunk) => {
            if (
              chunk !== "[DONE]" &&
              chunk.choices[0]?.finish_reason === "tool_calls"
            ) {
              // The run parks before the finish chunk goes out; the client
              // vanishes mid-write. (sink.fail retries this chunk once, so
              // only record the registry size on the first attempt.)
              if (bridgesAtFinishWrite === -1) {
                bridgesAtFinishWrite = proxy.toolBridges.size();
              }
              throw new Error("client went away");
            }
          },
        },
      },
    );

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      {},
    ) as Promise<unknown>;

    await expect(turn).rejects.toMatchObject({
      status: 500,
      message: "client went away",
    });

    // Registered before the final write, reclaimed when the write failed —
    // not left in the registry until the tool-result timeout.
    expect(bridgesAtFinishWrite).toBe(1);
    expect(proxy.toolBridges.size()).toBe(0);
    expect(await executeResult).toMatchObject({ isError: true });
    await waitFor(() => fake.lastSend().run.cancelled);
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

describe("responses client tool loop", () => {
  const flatTools = [
    {
      type: "function",
      name: "get_weather",
      description: "Get the weather",
      parameters: weatherTool.function.parameters,
    },
  ];

  test("pauses and resumes end-to-end through /v1/responses shapes", async () => {
    const proxy = makeProxy();
    const fake = createFakeAgent();
    seedSession(proxy, fake.agent, "agent-1");

    const firstTurn = executeAgentTurn({
      proxy,
      request: responsesToChatRequest({
        model: "composer-2.5",
        input: "Weather in NYC?",
        tools: flatTools,
      }),
    });

    await waitFor(() => fake.sends.length === 1);
    const customTools = fake.lastSend().options.local?.customTools;
    expect(customTools?.get_weather).toBeDefined();
    const executeResult = customTools!.get_weather!.execute(
      { city: "NYC" },
      { toolCallId: "sdk-tool-1" },
    ) as Promise<unknown>;

    const outcome1 = await firstTurn;
    const emitted = [...outcome1.state.toolCalls.values()][0]!;
    expect(proxy.toolBridges.size()).toBe(1);

    // The client follows the documented loop — input = input.concat(
    // response.output) — echoing reasoning and function_call output items,
    // then appending the function_call_output. The mapped call_id must
    // round-trip into the paused run's pending ids.
    const secondTurn = executeAgentTurn({
      proxy,
      request: responsesToChatRequest({
        model: "composer-2.5",
        input: [
          { type: "message", role: "user", content: "Weather in NYC?" },
          { type: "reasoning", summary: [] },
          {
            type: "function_call",
            call_id: emitted.id,
            name: "get_weather",
            arguments: emitted.arguments,
          },
          {
            type: "function_call_output",
            call_id: emitted.id,
            output: "Sunny, 25C",
          },
        ],
        tools: flatTools,
      }),
    });

    // The pending execute resolves and the original run resumes — no new send.
    expect(await executeResult).toBe("Sunny, 25C");
    expect(fake.sends.length).toBe(1);
    expect(proxy.toolBridges.size()).toBe(0);

    await fake.emit({ type: "text-delta", text: "It is sunny in NYC." } as never);
    await fake.emit({ type: "turn-ended" } as never);
    fake.finish("It is sunny in NYC.");

    const outcome2 = await secondTurn;
    expect(outcome2.finalText).toBe("It is sunny in NYC.");
    expect(outcome2.state.toolCalls.size).toBe(0);
  });
});
