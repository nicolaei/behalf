import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText, adapters } from "../../index.js";
import type { ModelCallResult, ModelPort, Profile } from "../../index.js";
import { assistantText, assistantToolCall, loggedEventTypes } from "./support.js";

describe("the agent loop", () => {
  // Deferred to a factory, not built at describe-scope: `tool()` isn't real
  // yet, and a describe body runs even when its `it`s are skipped.
  function scriptedFixture() {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
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
    const agentLoop = defineGraph("agent-loop", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flow.entry(respond);
      respond
        .when((result) => !(result as ModelCallResult).usedTools, flow.finish)
        .otherwise(respond);
    });
    return { agentLoop, scriptedPort, search, callCount: () => calls };
  }

  it("keeps looping while the model calls tools, finishes once it doesn't", async () => {
    const { agentLoop, scriptedPort, search, callCount } = scriptedFixture();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      store: adapters.stores.memoryStore(),
    });

    await runFlow(agentLoop, userText("find x"), ready);

    // called twice — once producing a tool call, once finishing
    expect(callCount()).toBe(2);
  });

  it("appends a tool call and its result to the session log", async () => {
    const { agentLoop, scriptedPort, search } = scriptedFixture();
    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      store,
    });

    await runFlow(agentLoop, userText("find x"), ready);

    // loose on exact position — confirm the full shape against reference.md when this slice is active
    const types = loggedEventTypes(store);
    expect(types).toContain("toolCall");
    expect(types).toContain("toolResult");
  });
});
