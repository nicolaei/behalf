import { describe, it, expect } from "vitest";
import { defineGraph, agentTurn, runtime, runFlow, userText } from "@behalf-js/core";
import type { ModelPort, AgentTurnResult } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { supportModel, supportAgent } from "./basic.js";

describe("profiles and models", () => {
  it("captures identity, context window, reasoning levels, and price on the model", () => {
    expect(supportModel.identifier).toBe("claude-sonnet-5");
    expect(supportModel.contextWindow).toBe(1_000_000);
    expect(supportModel.reasoning).toContain("medium");
    expect(supportModel.price).toEqual({ input: 3, output: 15 });
  });

  it("only asks for a reasoning level its model actually supports", () => {
    expect(supportAgent.reasoning).toBeDefined();
    expect(supportModel.reasoning).toContain(supportAgent.reasoning);
  });

  it("runs the profile through a turn with a matching scripted model", async () => {
    const scriptedPort: ModelPort = {
      model: supportModel,
      respond: () =>
        Promise.resolve({
          role: "assistant",
          provider: supportModel.provider,
          model: supportModel.identifier,
          content: [{ type: "text", text: "Here's how to reset your password." }],
          usage: { input: 12, output: 8 },
        }),
    };

    const turn = defineGraph("support-turn", (flow) => {
      const respond = flow.use(agentTurn(supportAgent));
      flow.entry(respond);
      respond.then(flow.finish);
    });

    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [],
      store: memoryStore(),
    });

    const result = (await runFlow(
      turn,
      userText("How do I reset my password?"),
      ready,
    )) as AgentTurnResult;

    expect(result).toEqual({
      finishedBy: "finalMessage",
      text: "Here's how to reset your password.",
    });
  });
});
