import { describe, it, expect } from "vitest";

// Proves the eval/ surface is reachable only via the package's "./eval"
// subpath export, never via its top-level entry — opt-in only, per the
// design note. Imports by real package specifier (not a relative path) so
// this actually exercises package.json's "exports" map and the built dist/
// output, not just the source tree.

const EVAL_SYMBOLS = [
  "agent",
  "example",
  "toolCalled",
  "toolCalledWith",
  "worldMatches",
  "outputMatches",
  "saidOn",
  "scoreBy",
  "llmJudge",
  "variance",
  "fixed",
  "checkRegression",
  "jsonlBaselineStore",
  "gate",
  "aggregate",
  "grid",
  "byScore",
  "byTimeToComplete",
  "byTokens",
  "byCost",
  "scenario",
  "explore",
];

describe("eval subpath export boundary", () => {
  it("every symbol in the eval barrel is reachable from the '@behalf-js/testing/eval' subpath", async () => {
    const evalModule = (await import("@behalf-js/testing/eval")) as Record<string, unknown>;
    for (const name of EVAL_SYMBOLS) {
      expect(evalModule[name], `expected "${name}" to be exported from @behalf-js/testing/eval`).toBeDefined();
    }
  });

  it("none of the eval symbols appear on the package's top-level entry", async () => {
    const topLevel = (await import("@behalf-js/testing")) as Record<string, unknown>;
    for (const name of EVAL_SYMBOLS) {
      expect(
        topLevel[name],
        `did not expect "${name}" to be exported from the top-level @behalf-js/testing entry`,
      ).toBeUndefined();
    }
  });

  it("the top-level entry still exports its own non-eval surface", async () => {
    const topLevel = (await import("@behalf-js/testing")) as Record<string, unknown>;
    expect(topLevel["stepOnce"]).toBeDefined();
    expect(topLevel["stepUntilBlocked"]).toBeDefined();
    expect(topLevel["fakePort"]).toBeDefined();
  });
});
