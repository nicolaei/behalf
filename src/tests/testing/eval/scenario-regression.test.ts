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
    // No prior baseline existed to compare against — `regressed` must be
    // absent, not `false` (an absent field means "not checked", `false` would
    // wrongly claim a comparison happened and it passed).
    const constResult = result.scorers.find((s) => s.name === "const");
    expect(constResult).not.toHaveProperty("regressed");
  });

  it("writes each scorer's baseline independently — a regressing scorer doesn't strand its siblings", async () => {
    const store = memoryBaselineStore();
    store.write("t1", {
      a: { mean: 1, median: 1, stddev: 0, min: 1, max: 1, passRate: 1 },
      b: { mean: 0, median: 0, stddev: 0, min: 0, max: 0, passRate: 1 },
    });
    const tinyAgent = agent("tiny", { model: fakePort().model, system: "t", tools: [] });

    await runScenario({
      of: tinyAgent,
      world: () => ({}),
      fixtures: () => ({ models: fakePort(), bindings: [] }),
      input: userText("hi"),
      scorers: [
        // regresses: clears its own bar (0.5) but falls short of fixed(0.1)'s
        // 1 - 0.1 = 0.9 threshold against the stored baseline mean of 1.
        scoreBy("a", () => 0.8, { minimumScore: 0.5 }),
        // improves: clears its own bar and clears fixed(0.1)'s threshold
        // against the stored baseline mean of 0.
        scoreBy("b", () => 1, { minimumScore: 0.5 }),
      ],
      regression: fixed(0.1),
      baseline: { store, test: "t1" },
    });

    const after = store.read("t1");
    expect(after?.["a"]?.mean).toBe(1); // regressed — baseline preserved, not stranded-forward
    expect(after?.["b"]?.mean).toBe(1); // didn't regress — baseline advances
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
