import { describe, it, expect } from "vitest";
import { defineGraph, agentTurn, runtime, runFlow, userText } from "@behalf-js/core";
import type { ModelPort, Profile, AgentTurnResult } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { search, supportBundle, searchBinding, supportBundleBinding } from "./search-tool.js";

/** A scripted ModelPort that calls a tool once, then answers using its result. */
function scriptedPort(): ModelPort {
  let calls = 0;
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
    respond: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          role: "assistant",
          provider: "test",
          model: "scripted",
          content: [
            {
              type: "toolCall",
              correlationId: "call-1",
              name: "search",
              input: { query: "password" },
            },
          ],
          usage: { input: 1, output: 1 },
        });
      }
      return Promise.resolve({
        role: "assistant",
        provider: "test",
        model: "scripted",
        content: [{ type: "text", text: "You can reset your password from account settings." }],
        usage: { input: 1, output: 1 },
      });
    },
  };
}

describe("tools and handlers", () => {
  it("runs a direct tool binding (provide) through a turn", async () => {
    const profile: Profile = {
      model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
      system: "You answer using the search tool.",
      tools: [search],
    };
    const turn = defineGraph("search-turn", (flow) => {
      const respond = flow.use(agentTurn(profile));
      flow.entry(respond);
      respond.then(flow.finish);
    });

    const port = scriptedPort();
    const ready = await runtime({
      models: () => port,
      bindings: [searchBinding],
      store: memoryStore(),
    });

    const result = (await runFlow(
      turn,
      userText("How do I reset my password?"),
      ready,
    )) as AgentTurnResult;

    expect(result).toEqual({
      finishedBy: "finalMessage",
      text: "You can reset your password from account settings.",
    });
  });

  it("runs a toolset binding (expand) through a turn the same way", async () => {
    const profile: Profile = {
      model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
      system: "You answer using the support bundle.",
      tools: [supportBundle],
    };
    const turn = defineGraph("support-bundle-turn", (flow) => {
      const respond = flow.use(agentTurn(profile));
      flow.entry(respond);
      respond.then(flow.finish);
    });

    const port = scriptedPort();
    const ready = await runtime({
      models: () => port,
      bindings: [supportBundleBinding],
      store: memoryStore(),
    });

    const result = (await runFlow(
      turn,
      userText("How do I reset my password?"),
      ready,
    )) as AgentTurnResult;

    expect(result).toEqual({
      finishedBy: "finalMessage",
      text: "You can reset your password from account settings.",
    });
  });
});
