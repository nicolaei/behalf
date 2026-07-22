import { describe, it, expect } from "vitest";
import { provide, tool, userText } from "../../../index.js";
import type { ModelPort } from "../../../index.js";
import { assistantToolCall, assistantText } from "../../acceptance/support.js";
import { runScenario } from "../../../testing/eval/harness/scenario.js";
import { toolCalled, worldMatches } from "../../../testing/eval/scorers.js";
import { agent } from "../../../testing/eval/subject.js";

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
});
