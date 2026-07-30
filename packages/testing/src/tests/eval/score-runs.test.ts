import { describe, it, expect } from "vitest";
import { scoreRuns } from "../../eval/harness/score-runs.js";
import { scoreBy } from "../../eval/scorers.js";
import type { Run } from "../../eval/run.js";

function run(output: unknown): Run {
  return {
    output,
    world: undefined,
    tools: [],
    traversal: [],
    visits: [],
    usage: { input: 0, output: 0 },
    latency: 0,
    threads: [],
    lastReply: () => undefined,
    messages: () => [],
  };
}

describe("scoreRuns", () => {
  it("calls scorer.score on every run and returns the raw scores array", async () => {
    const scorer = scoreBy("byOutput", (r) => (r.output as number));
    const { scores } = await scoreRuns(scorer, [run(1), run(0), run(1)]);
    expect(scores).toEqual([1, 0, 1]);
  });

  it("folds the scores into a Distribution using scorer.minimumScore as the passRate bar", async () => {
    const scorer = scoreBy("byOutput", (r) => (r.output as number), { minimumScore: 1 });
    const { distribution } = await scoreRuns(scorer, [run(1), run(0), run(1), run(0)]);
    expect(distribution.mean).toBe(0.5);
    expect(distribution.passRate).toBe(0.5); // half the runs cleared minimumScore: 1
  });

  it("awaits an async scorer's score function", async () => {
    const scorer = scoreBy("asyncScore", (r) => Promise.resolve(r.output as number));
    const { scores } = await scoreRuns(scorer, [run(0.7)]);
    expect(scores).toEqual([0.7]);
  });

  it("handles an empty runs array without throwing", async () => {
    const scorer = scoreBy("byOutput", (r) => (r.output as number));
    const { scores, distribution } = await scoreRuns(scorer, []);
    expect(scores).toEqual([]);
    expect(distribution.mean).toBe(0);
  });
});
