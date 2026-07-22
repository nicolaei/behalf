import { describe, it, expect } from "vitest";
import type { Run } from "../../../testing/graph/run.js";
import type { ThreadId, Usage } from "../../../index.js";
import {
  toolCalled,
  toolCalledWith,
  worldMatches,
  outputMatches,
  saidOn,
  scoreBy,
} from "../../../testing/eval/scorers.js";

function fakeRun<World = unknown, Output = unknown>(
  overrides: Partial<Run<World, Output>>,
): Run<World, Output> {
  return {
    output: undefined as Output,
    world: {} as World,
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

describe("basic scorers", () => {
  const t1 = "t1" as ThreadId;

  it("toolCalled scores 1 when the tool appears in run.tools, 0 otherwise", () => {
    const withCall = fakeRun({ tools: [{ name: "search", input: {}, output: {}, thread: t1 }] });
    const withoutCall = fakeRun({ tools: [] });
    expect(toolCalled("search").score(withCall)).toBe(1);
    expect(toolCalled("search").score(withoutCall)).toBe(0);
  });

  it("toolCalledWith checks the matching call's input", () => {
    const run = fakeRun({
      tools: [{ name: "search", input: { query: "x" }, output: {}, thread: t1 }],
    });
    expect(toolCalledWith("search", (i) => (i as { query: string }).query === "x").score(run)).toBe(
      1,
    );
    expect(toolCalledWith("search", (i) => (i as { query: string }).query === "y").score(run)).toBe(
      0,
    );
  });

  it("worldMatches reads run.world", () => {
    expect(worldMatches((w: { n: number }) => w.n === 1).score(fakeRun({ world: { n: 1 } }))).toBe(
      1,
    );
  });

  it("outputMatches reads run.output", () => {
    expect(outputMatches((o) => o === "rename").score(fakeRun({ output: "rename" }))).toBe(1);
  });

  it("saidOn reads lastReply(thread) against a pattern", () => {
    const run = fakeRun({
      lastReply: () => ({
        role: "assistant",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0 },
        content: [{ type: "text", text: "ready to plan" }],
      }),
    });
    expect(saidOn(undefined, /ready to plan/i).score(run)).toBe(1);
  });

  it("scoreBy wraps an arbitrary function unchanged", () => {
    expect(scoreBy("custom", () => 0.7).score(fakeRun({}))).toBe(0.7);
  });

  it("bars override minimumScore/minimumPassRate", () => {
    expect(toolCalled("search", { minimumScore: 0.5 }).minimumScore).toBe(0.5);
  });
});
