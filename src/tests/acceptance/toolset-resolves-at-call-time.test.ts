import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, toolset, expand } from "../../index.js";
import type { ModelPort, Profile } from "../../index.js";
import { assistantToolCall, assistantText, loggedEventTypes } from "./support.js";

// Needs runtime() to eagerly expand every toolset binding's discover() once,
// merging it with direct tool bindings into one name-keyed lookup that
// findToolBinding reads from — currently findToolBinding only ever matches
// kind === "tool" bindings, so a toolset member is never found by name.
// Written now so the shape is pinned down before that slice starts.
describe("a model calling a tool that came from an expanded toolset", () => {
  function fixture() {
    const bundle = toolset("search-bundle", "Search-related tools.");
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
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [bundle] };
    const binding = expand(bundle, () =>
      Promise.resolve({ search: (input: unknown) => Promise.resolve({ hits: [input] }) }),
    );

    const agentLoop = defineGraph("toolset-agent-loop", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flow.entry(respond);
      respond
        .when((result) => !(result as { usedTools: boolean }).usedTools, flow.finish)
        .otherwise(respond);
    });

    return { agentLoop, scriptedPort, binding };
  }

  it("resolves the toolset's member by name and runs its handler", async () => {
    const { agentLoop, scriptedPort, binding } = fixture();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [binding],
      store: adapters.stores.memoryStore(),
    });

    // if this doesn't throw "no tool binding for search", the toolset member was found and called
    await runFlow(agentLoop, userText("find x"), ready);
  });

  it("appends the toolset member's tool call and result to the session log", async () => {
    const { agentLoop, scriptedPort, binding } = fixture();
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: () => scriptedPort, bindings: [binding], store });

    await runFlow(agentLoop, userText("find x"), ready);

    const types = loggedEventTypes(store);
    expect(types).toContain("toolCall");
    expect(types).toContain("toolResult");
  });
});
