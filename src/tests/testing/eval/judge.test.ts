import { describe, it, expect } from "vitest";
import type { Run } from "../../../testing/graph/run.js";
import type { Usage } from "../../../index.js";
import { assistantText } from "../../acceptance/support.js";
import { llmJudge } from "../../../testing/eval/judge.js";
import type { Judge } from "../../../testing/eval/judge.js";

function fakeRun(overrides: Partial<Run>): Run {
  return {
    output: undefined,
    world: {},
    tools: [],
    traversal: [],
    visits: [],
    usage: {} as Usage,
    latency: 0,
    threads: [],
    lastReply: () => undefined,
    messages: () => [],
    ...overrides,
  };
}

describe("llmJudge", () => {
  it("scores via the injected judge, not a hardcoded value", async () => {
    const fakeJudge: Judge = {
      rate: (rubric) => Promise.resolve(rubric.includes("complete") ? 0.9 : 0.1),
    };
    const run = fakeRun({ lastReply: () => assistantText("done") });
    const scorer = llmJudge("the plan is complete", undefined, fakeJudge);
    expect(await scorer.score(run)).toBe(0.9);
  });

  it("defaults minimumScore to 0.8", () => {
    expect(llmJudge("anything").minimumScore).toBe(0.8);
  });
});
