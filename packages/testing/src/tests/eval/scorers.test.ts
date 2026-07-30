import { describe, it, expect } from "vitest";
import {
  toolCalled,
  toolCalledWith,
  worldMatches,
  outputMatches,
  saidOn,
  scoreBy,
} from "../../eval/scorers.js";
import type { Run, ToolTrace } from "../../eval/run.js";
import type { AssistantMessage } from "@behalf-js/core";

function tool(overrides: Partial<ToolTrace>): ToolTrace {
  return { name: "search", input: {}, output: {}, thread: "t1" as never, ...overrides };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

function run<World = unknown, Output = unknown>(overrides: Partial<Run<World, Output>>): Run<World, Output> {
  return {
    output: undefined as Output,
    world: undefined as World,
    tools: [],
    traversal: [],
    visits: [],
    usage: { input: 0, output: 0 },
    latency: 0,
    threads: [],
    lastReply: () => undefined,
    messages: () => [],
    ...overrides,
  };
}

describe("toolCalled", () => {
  it("scores 1 when a call to that name appears in run.tools", () => {
    const scorer = toolCalled("search");
    expect(scorer.score(run({ tools: [tool({ name: "search" })] }))).toBe(1);
  });

  it("scores 0 when no call to that name appears", () => {
    const scorer = toolCalled("search");
    expect(scorer.score(run({ tools: [tool({ name: "other" })] }))).toBe(0);
  });

  it("defaults minimumScore to 1", () => {
    expect(toolCalled("search").minimumScore).toBe(1);
  });

  it("accepts a bars override", () => {
    expect(toolCalled("search", { minimumScore: 0.5 }).minimumScore).toBe(0.5);
  });
});

describe("toolCalledWith", () => {
  it("scores 1 when a call to that name satisfies the predicate", () => {
    const scorer = toolCalledWith("search", (input) => (input as { q: string }).q === "x");
    expect(scorer.score(run({ tools: [tool({ name: "search", input: { q: "x" } })] }))).toBe(1);
  });

  it("scores 0 when the call's input does not satisfy the predicate", () => {
    const scorer = toolCalledWith("search", (input) => (input as { q: string }).q === "x");
    expect(scorer.score(run({ tools: [tool({ name: "search", input: { q: "y" } })] }))).toBe(0);
  });

  it("scores 0 when the name never appears at all", () => {
    const scorer = toolCalledWith("search", () => true);
    expect(scorer.score(run({ tools: [] }))).toBe(0);
  });
});

describe("worldMatches", () => {
  it("scores 1 when the predicate holds for run.world", () => {
    const scorer = worldMatches((world: { hits: string[] }) => world.hits.length === 1);
    expect(scorer.score(run({ world: { hits: ["a"] } }))).toBe(1);
  });

  it("scores 0 when the predicate fails", () => {
    const scorer = worldMatches((world: { hits: string[] }) => world.hits.length === 1);
    expect(scorer.score(run({ world: { hits: [] } }))).toBe(0);
  });
});

describe("outputMatches", () => {
  it("scores 1 when the predicate holds for run.output", () => {
    const scorer = outputMatches((output: string) => output === "RESOLVE");
    expect(scorer.score(run({ output: "RESOLVE" }))).toBe(1);
  });

  it("scores 0 when the predicate fails", () => {
    const scorer = outputMatches((output: string) => output === "RESOLVE");
    expect(scorer.score(run({ output: "ESCALATE" }))).toBe(0);
  });
});

describe("saidOn", () => {
  it("scores 1 when lastReply(thread)'s text includes a string pattern", () => {
    const scorer = saidOn("t1", "hello");
    expect(scorer.score(run({ lastReply: () => assistant("well hello there") }))).toBe(1);
  });

  it("scores 0 when the text does not include the string pattern", () => {
    const scorer = saidOn("t1", "hello");
    expect(scorer.score(run({ lastReply: () => assistant("goodbye") }))).toBe(0);
  });

  it("scores 1 when lastReply(thread)'s text matches a RegExp pattern", () => {
    const scorer = saidOn("t1", /^RESOLVE$/);
    expect(scorer.score(run({ lastReply: () => assistant("RESOLVE") }))).toBe(1);
  });

  it("scores 0 when there is no reply at all", () => {
    const scorer = saidOn("t1", "hello");
    expect(scorer.score(run({ lastReply: () => undefined }))).toBe(0);
  });

  it("passes its thread argument through to run.lastReply", () => {
    let seenThread: string | undefined;
    const scorer = saidOn("t1", "hello");
    scorer.score(
      run({
        lastReply: (thread) => {
          seenThread = thread;
          return assistant("hello");
        },
      }),
    );
    expect(seenThread).toBe("t1");
  });
});

describe("scoreBy", () => {
  it("is a passthrough escape hatch: whatever fn returns is the score", () => {
    const scorer = scoreBy("custom", () => 0.42);
    expect(scorer.score(run({}))).toBe(0.42);
  });

  it("carries the given name", () => {
    expect(scoreBy("custom", () => 1).name).toBe("custom");
  });
});
