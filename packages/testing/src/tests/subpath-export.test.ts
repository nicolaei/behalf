import { describe, it, expect } from "vitest";

// Proves this package's three subpaths carry the surfaces the layering says
// they should: the root is the pure engine stepping vocabulary, "./ai" holds
// the fakes that only make sense once the ai extension is registered, and
// "./eval" is the opt-in evaluation harness atop ai. Imports by real package
// specifier (not a relative path) so this exercises package.json's "exports"
// map and the built dist/ output, not just the source tree.

const ROOT_SYMBOLS = [
  "stepOnce",
  "stepUntilBlocked",
  "stepUntil",
  "atNode",
  "StepUntilError",
  "runToCompletion",
];

const AI_SYMBOLS = ["fakePort"];

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

describe("subpath export boundaries", () => {
  it("the root entry exports the engine stepping vocabulary", async () => {
    const root = (await import("@behalf-js/testing")) as Record<string, unknown>;
    for (const name of ROOT_SYMBOLS) {
      expect(root[name], `expected "${name}" to be exported from @behalf-js/testing`).toBeDefined();
    }
  });

  it("the root entry exports nothing ai-shaped", async () => {
    const root = (await import("@behalf-js/testing")) as Record<string, unknown>;
    for (const name of [...AI_SYMBOLS, ...EVAL_SYMBOLS]) {
      expect(
        root[name],
        `did not expect "${name}" to be exported from the root @behalf-js/testing entry`,
      ).toBeUndefined();
    }
  });

  it("the ai subpath exports the model fakes", async () => {
    const ai = (await import("@behalf-js/testing/ai")) as Record<string, unknown>;
    for (const name of AI_SYMBOLS) {
      expect(
        ai[name],
        `expected "${name}" to be exported from @behalf-js/testing/ai`,
      ).toBeDefined();
    }
  });

  it("every symbol in the eval barrel is reachable from the '@behalf-js/testing/eval' subpath", async () => {
    const evalModule = (await import("@behalf-js/testing/eval")) as Record<string, unknown>;
    for (const name of EVAL_SYMBOLS) {
      expect(
        evalModule[name],
        `expected "${name}" to be exported from @behalf-js/testing/eval`,
      ).toBeDefined();
    }
  });
});
