// The Learn "Setting up fakes" page's example. Every claim the page makes
// about fakePort, a scripted ModelPort, and a faked tool binding is a real,
// passing vitest test here: there's no separate companion file.

import { describe, it, expect } from "vitest";
import {
  defineGraph,
  agentTurn,
  userText,
  runtime,
  runFlow,
  provide,
  tool,
} from "@behalf-js/core";
import type { ModelPort, Profile, AssistantMessage } from "@behalf-js/core";
import { fakePort } from "@behalf-js/testing";
import { memoryStore } from "@behalf-js/stores";
import { z } from "zod";

// #region fake-port
const assistant: Profile = { model: fakePort.model, system: "You are a helpful assistant.", tools: [] };

const chat = defineGraph("fake-chat", (flow) => {
  const turn = flow.use(agentTurn(assistant));
  flow.entry(turn);
  turn.then(flow.finish);
});

describe("fakePort", () => {
  it("always replies \"ok\", with no tool calls", async () => {
    const ready = await runtime({ models: () => fakePort, bindings: [], store: memoryStore() });

    const result = await runFlow(chat, userText("What's the weather?"), ready);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "ok" });
  });
});
// #endregion fake-port

// #region scripted-port
/** A ModelPort that replies with the next entry in `script`, in order: one reply per `respond()` call, so a test can drive a multi-turn conversation deterministically. Throws once the script runs out, rather than silently repeating its last reply. */
function scriptedPort(script: AssistantMessage["content"][]): ModelPort {
  let call = 0;
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
    respond: () => {
      const content = script[call];
      if (!content) throw new Error(`scriptedPort: no script entry for call ${String(call + 1)}`);
      call += 1;
      return Promise.resolve({
        role: "assistant",
        provider: "test",
        model: "scripted",
        content,
        usage: { input: 1, output: 1 },
      });
    },
  };
}

describe("scriptedPort", () => {
  it("replies with a different message each call", async () => {
    const persona: Profile = {
      model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
      system: "Say ESCALATE or RESOLVE.",
      tools: [],
    };
    const classify = defineGraph("classify", (flow) => {
      const turn = flow.use(agentTurn(persona));
      flow.entry(turn);
      turn.then(flow.finish);
    });

    const port = scriptedPort([
      [{ type: "text", text: "RESOLVE" }],
      [{ type: "text", text: "ESCALATE" }],
    ]);
    const ready = await runtime({ models: () => port, bindings: [], store: memoryStore() });

    const first = await runFlow(classify, userText("Ticket one."), ready);
    const second = await runFlow(classify, userText("Ticket two."), ready);

    expect(first).toEqual({ finishedBy: "finalMessage", text: "RESOLVE" });
    expect(second).toEqual({ finishedBy: "finalMessage", text: "ESCALATE" });
  });
});
// #endregion scripted-port

// #region fake-tool
const getWeather = tool(
  "get_weather",
  "Look up the current weather for a city.",
  z.object({ city: z.string() }),
);

describe("faking a tool", () => {
  it("resolves a tool call with a canned handler result", async () => {
    const persona: Profile = {
      model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
      system: "Look up the weather, then report it.",
      tools: [getWeather],
    };
    const chatWithTool = defineGraph("chat-with-tool", (flow) => {
      const turn = flow.use(agentTurn(persona));
      flow.entry(turn);
      turn.then(flow.finish);
    });

    let handlerCalls = 0;
    const port = scriptedPort([
      [{ type: "toolCall", correlationId: "call-1", name: "get_weather", input: { city: "Oslo" } }],
      [{ type: "text", text: "It's 14°C and sunny in Oslo." }],
    ]);
    const ready = await runtime({
      models: () => port,
      bindings: [
        provide(getWeather, async (input) => {
          handlerCalls += 1;
          expect(input).toEqual({ city: "Oslo" });
          return { tempC: 14, condition: "sunny" };
        }),
      ],
      store: memoryStore(),
    });

    const result = await runFlow(chatWithTool, userText("What's the weather in Oslo?"), ready);

    expect(handlerCalls).toBe(1);
    expect(result).toEqual({
      finishedBy: "finalMessage",
      text: "It's 14°C and sunny in Oslo.",
    });
  });
});
// #endregion fake-tool
