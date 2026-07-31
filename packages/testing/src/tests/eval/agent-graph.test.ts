import { describe, it, expect } from "vitest";
import { runFlow, runtime, provide, tool, userText } from "@behalf-js/core";
import type { ModelPort, Profile, AssistantMessage, ModelCallResult } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { agentGraph } from "../../eval/harness/agent-graph.js";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

function assistantToolCall(name: string, input: unknown): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "toolCall", correlationId: "1", name, input }],
    usage: { input: 1, output: 1 },
  };
}

const search = tool<{ query: string }, { hits: string[] }>("search", "Searches for a query.");

describe("agentGraph", () => {
  it("finishes in one model call when the model doesn't use tools", async () => {
    let calls = 0;
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => {
        calls += 1;
        return Promise.resolve(assistantText("done immediately"));
      },
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [] };
    const ready = await runtime({ models: () => scriptedPort, bindings: [], store: memoryStore() });

    const result = (await runFlow(agentGraph(profile), userText("hi"), ready)) as ModelCallResult;

    expect(calls).toBe(1);
    expect(result.usedTools).toBe(false);
  });

  it("loops back to itself while the model uses tools, finishes once it doesn't", async () => {
    let calls = 0;
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? assistantToolCall("search", { query: "x" }) : assistantText("done"),
        );
      },
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [search] };
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      store: memoryStore(),
    });

    const result = (await runFlow(
      agentGraph(profile),
      userText("find x"),
      ready,
    )) as ModelCallResult;

    expect(calls).toBe(2); // one tool-calling turn, one finishing turn
    expect(result.usedTools).toBe(false); // the turn that actually finished the flow
  });

  it("calls the model a third time if it keeps using tools", async () => {
    let calls = 0;
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => {
        calls += 1;
        return Promise.resolve(
          calls <= 2 ? assistantToolCall("search", { query: "x" }) : assistantText("done"),
        );
      },
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [search] };
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      store: memoryStore(),
    });

    await runFlow(agentGraph(profile), userText("find x"), ready);

    expect(calls).toBe(3);
  });
});
