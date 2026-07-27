// The Learn "Evaluating personas" page's example: no library type for a
// "case," no built-in runner. Plain vitest, a plain array, and the same
// stepUntilBlocked/runFlow this section's earlier pages already cover.

import { describe, it, expect } from "vitest";
import { defineGraph, agentTurn, userText, runtime, runFlow } from "@behalf-js/core";
import type { ModelPort, Profile, AssistantMessage } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";

const triagePersona: Profile = {
  model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
  system:
    'Read this support ticket and reply with exactly one word: "RESOLVE" if you can answer it ' +
    'directly, "ESCALATE" if it needs a person.',
  tools: [],
};

const triage = defineGraph("triage-persona", (flow) => {
  const turn = flow.use(agentTurn(triagePersona));
  flow.entry(turn);
  turn.then(flow.finish);
});

/** Replies with the next entry in `script`, one call at a time: the same pattern setting-up-fakes.md names `scriptedPort`. */
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

// #region cases
interface Case {
  input: string;
  modelReply: string; // what the persona's underlying model says this turn
  check: (result: unknown) => boolean;
}

const cases: Case[] = [
  {
    input: "How do I reset my password?",
    modelReply: "RESOLVE",
    check: (result) => (result as { text: string }).text === "RESOLVE",
  },
  {
    input: "My account was hacked and I need this fixed now.",
    modelReply: "ESCALATE",
    check: (result) => (result as { text: string }).text === "ESCALATE",
  },
  {
    input: "What are your business hours?",
    modelReply: "RESOLVE",
    check: (result) => (result as { text: string }).text === "RESOLVE",
  },
];
// #endregion cases

// #region run-each
describe("triage persona", () => {
  it.each(cases)("classifies: $input", async ({ input, modelReply, check }) => {
    const ready = await runtime({
      models: () => scriptedPort([[{ type: "text", text: modelReply }]]),
      bindings: [],
      store: memoryStore(),
    });

    const result = await runFlow(triage, userText(input), ready);

    expect(check(result)).toBe(true);
  });
});
// #endregion run-each

// #region score
describe("scoring the whole table", () => {
  it("scores every case by exact match, one point each", async () => {
    let passed = 0;

    for (const testCase of cases) {
      const ready = await runtime({
        models: () => scriptedPort([[{ type: "text", text: testCase.modelReply }]]),
        bindings: [],
        store: memoryStore(),
      });
      const result = await runFlow(triage, userText(testCase.input), ready);
      if (testCase.check(result)) passed += 1;
    }

    expect(passed).toBe(cases.length);
  });
});
// #endregion score
