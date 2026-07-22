import { describe, it, expect } from "vitest";
import { userText } from "../../../index.js";
import type { ModelPort } from "../../../index.js";
import { assistantText } from "../../acceptance/support.js";
import { runScenario } from "../../../testing/eval/harness/scenario.js";
import { scoreBy } from "../../../testing/eval/scorers.js";
import { agent } from "../../../testing/eval/subject.js";
import { fixed } from "../../../testing/eval/regression.js";
import type { BaselineStore, Distribution } from "../../../testing/eval/regression.js";

// Bug report: scenario() accepted `regression` and silently dropped it — no
// BaselineStore/test-name to key a comparison by. This acceptance test drives
// runScenario twice against one shared (fake) BaselineStore, through the
// public eval barrel only.

function fakePort(): ModelPort {
  return {
    model: { identifier: "fake", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: () => Promise.resolve(assistantText("done")),
  };
}

function memoryBaselineStore(): BaselineStore {
  const data = new Map<string, Record<string, Distribution>>();
  return {
    read: (test) => data.get(test),
    write: (test, scorers) => {
      data.set(test, scorers);
    },
  };
}

describe("runScenario regression", () => {
  it("establishes a baseline on the first run (nothing to regress against yet)", async () => {
    const store = memoryBaselineStore();
    const tinyAgent = agent("tiny", { model: fakePort().model, system: "t", tools: [] });

    const result = await runScenario({
      of: tinyAgent,
      world: () => ({}),
      fixtures: () => ({ models: fakePort(), bindings: [] }),
      input: userText("hi"),
      scorers: [scoreBy("const", () => 1)],
      regression: fixed(0.1),
      baseline: { store, test: "t1" },
    });

    expect(result.passed).toBe(true);
    expect(store.read("t1")?.["const"]?.mean).toBe(1);
  });

  it("fails when the current run regresses beyond the policy threshold, even though it clears its own bar", async () => {
    const store = memoryBaselineStore();
    store.write("t1", { const: { mean: 1, median: 1, stddev: 0, min: 1, max: 1, passRate: 1 } });
    const tinyAgent = agent("tiny", { model: fakePort().model, system: "t", tools: [] });

    const result = await runScenario({
      of: tinyAgent,
      world: () => ({}),
      fixtures: () => ({ models: fakePort(), bindings: [] }),
      input: userText("hi"),
      // 0.8 clears the scorer's own bar (minimumScore: 0.5) but the baseline
      // mean is 1, so fixed(0.1) requires >= 0.9 — a regression.
      scorers: [scoreBy("const", () => 0.8, { minimumScore: 0.5 })],
      regression: fixed(0.1),
      baseline: { store, test: "t1" },
    });

    const constResult = result.scorers.find((s) => s.name === "const");
    expect(constResult?.passed).toBe(true); // clears its own bar
    expect(result.passed).toBe(false); // but the scenario still fails on regression
  });
});
