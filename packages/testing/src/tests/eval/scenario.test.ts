import { describe, it, expect } from "vitest";
import { provide, tool, userText } from "@behalf-js/core";
import type { ModelPort, AssistantMessage } from "@behalf-js/core";
import { runScenario, scenario } from "../../eval/harness/scenario.js";
import { toolCalled, worldMatches, scoreBy } from "../../eval/scorers.js";
import { agent } from "../../eval/subject.js";
import { fixed } from "../../eval/regression.js";
import type { BaselineStore, Distribution } from "../../eval/regression.js";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

function assistantToolCall(name: string, input: unknown): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "toolCall", correlationId: "1", name, input }],
    usage: { input: 1, output: 1 },
  };
}

const search = tool<{ query: string }, { hits: string[] }>("search", "Searches for a query.");

function scriptedPortThatCallsTool(): ModelPort {
  let calls = 0;
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: () =>
      Promise.resolve(
        calls++ === 0 ? assistantToolCall("search", { query: "x" }) : assistantText("done"),
      ),
  };
}

function scriptedPortThatNeverCallsTool(): ModelPort {
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: () => Promise.resolve(assistantText("done")),
  };
}

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

describe("runScenario", () => {
  it("gates: passes when every scorer clears its bar at the required rate", async () => {
    const tinyAgent = agent<{ hits: string[] }>("tiny", {
      model: scriptedPortThatCallsTool().model,
      system: "t",
      tools: [search],
    });

    const result = await runScenario({
      of: tinyAgent,
      runs: { count: 3, minimumPassRate: 1 },
      world: (): { hits: string[] } => ({ hits: [] }),
      fixtures: (w) => ({
        models: scriptedPortThatCallsTool(),
        bindings: [
          provide(search, (input: { query: string }) => {
            w.hits.push(input.query);
            return Promise.resolve({ hits: ["a"] });
          }),
        ],
      }),
      input: userText("find x"),
      scorers: [toolCalled("search"), worldMatches((w: { hits: string[] }) => w.hits.length === 1)],
    });

    expect(result.passed).toBe(true);
    expect(result.scorers.every((s) => s.passed)).toBe(true);
  });

  it("fails when a scorer's pass-rate misses the bar", async () => {
    const tinyAgent = agent<{ hits: string[] }>("tiny", {
      model: scriptedPortThatNeverCallsTool().model,
      system: "t",
      tools: [search],
    });

    const result = await runScenario({
      of: tinyAgent,
      runs: { count: 3, minimumPassRate: 1 },
      world: (): { hits: string[] } => ({ hits: [] }),
      fixtures: () => ({
        models: scriptedPortThatNeverCallsTool(),
        bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      }),
      input: userText("find x"),
      scorers: [toolCalled("search")],
    });

    expect(result.passed).toBe(false);
    const toolCalledResult = result.scorers.find((s) => s.name === "toolCalled(search)");
    expect(toolCalledResult?.passed).toBe(false);
  });

  it("uses every row in `given`, running each `runs.count` times", async () => {
    let calls = 0;
    const tinyAgent = agent<{ hits: string[] }>("tiny", {
      model: fakePort().model,
      system: "t",
      tools: [],
    });

    await runScenario({
      of: tinyAgent,
      runs: 2,
      given: [
        {
          name: "row-a",
          world: () => ({ hits: [] }),
          fixtures: () => {
            calls += 1;
            return { models: fakePort(), bindings: [] };
          },
          input: userText("a"),
        },
        {
          name: "row-b",
          world: () => ({ hits: [] }),
          fixtures: () => {
            calls += 1;
            return { models: fakePort(), bindings: [] };
          },
          input: userText("b"),
        },
      ],
      scorers: [scoreBy("const", () => 1)],
    });

    expect(calls).toBe(4); // 2 rows x 2 runs each
  });

  it("throws a clear error when `given` is omitted and `input` is also missing", async () => {
    const tinyAgent = agent("tiny", { model: fakePort().model, system: "t", tools: [] });

    await expect(
      runScenario({
        of: tinyAgent,
        world: () => ({}),
        fixtures: () => ({ models: fakePort(), bindings: [] }),
        scorers: [scoreBy("const", () => 1)],
      }),
    ).rejects.toThrow(/input/);
  });
});

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
    // absent, not `false` (absent means "not checked").
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

describe("scenario", () => {
  // scenario() is a thin wrapper: describe(name, () => it("gates", async () =>
  // expect((await runScenario(spec)).passed).toBe(true))). runScenario's own
  // gating logic is exhaustively covered above; this only proves the wrapper
  // itself registers and runs without throwing, using a spec designed to
  // pass — a spec designed to fail would register a genuinely failing nested
  // test in this very suite, which is worse coverage than no coverage.
  const tinyAgent = agent("tiny", { model: fakePort().model, system: "t", tools: [] });

  scenario("a passing scenario registered via the public wrapper", {
    of: tinyAgent,
    world: () => ({}),
    fixtures: () => ({ models: fakePort(), bindings: [] }),
    input: userText("hi"),
    scorers: [scoreBy("const", () => 1)],
  });
});
