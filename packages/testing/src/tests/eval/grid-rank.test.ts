import { describe, it, expect } from "vitest";
import { grid, byScore, byTimeToComplete, byTokens, byCost } from "../../eval/harness/rank.js";
import type { Metrics } from "../../eval/harness/rank.js";

describe("grid", () => {
  it("is the cross-product of two axes", () => {
    const variants = grid({ model: ["a", "b"], temperature: [0, 1] } as never);
    expect(variants).toHaveLength(4);
    expect(variants).toEqual(
      expect.arrayContaining([
        { model: "a", temperature: 0 },
        { model: "a", temperature: 1 },
        { model: "b", temperature: 0 },
        { model: "b", temperature: 1 },
      ]),
    );
  });

  it("is the cross-product of three axes", () => {
    const variants = grid({ a: [1, 2], b: [3, 4], c: [5, 6] } as never);
    expect(variants).toHaveLength(8);
  });

  it("returns a single empty variant for zero axes", () => {
    expect(grid({})).toEqual([{}]);
  });

  it("a single axis produces one variant per value", () => {
    const variants = grid({ model: ["a", "b", "c"] } as never);
    expect(variants).toEqual([{ model: "a" }, { model: "b" }, { model: "c" }]);
  });
});

function metrics(overrides: Partial<Metrics>): Metrics {
  return {
    score: 0,
    usage: { input: 0, output: 0 },
    timeToComplete: 0,
    ...overrides,
  };
}

describe("byScore", () => {
  it("orders higher score first", () => {
    const items = [metrics({ score: 0.2 }), metrics({ score: 0.9 }), metrics({ score: 0.5 })];
    const sorted = [...items].sort((a, b) => byScore(b) - byScore(a));
    expect(sorted.map((m) => m.score)).toEqual([0.9, 0.5, 0.2]);
  });
});

describe("byTimeToComplete", () => {
  it("orders faster (lower time-to-complete) first", () => {
    const items = [
      metrics({ timeToComplete: 300 }),
      metrics({ timeToComplete: 100 }),
      metrics({ timeToComplete: 200 }),
    ];
    const sorted = [...items].sort((a, b) => byTimeToComplete(b) - byTimeToComplete(a));
    expect(sorted.map((m) => m.timeToComplete)).toEqual([100, 200, 300]);
  });
});

describe("byTokens", () => {
  it("orders fewer total tokens (input+output) first", () => {
    const items = [
      metrics({ usage: { input: 100, output: 100 } }),
      metrics({ usage: { input: 10, output: 10 } }),
      metrics({ usage: { input: 50, output: 50 } }),
    ];
    const sorted = [...items].sort((a, b) => byTokens(b) - byTokens(a));
    expect(sorted.map((m) => m.usage.input + m.usage.output)).toEqual([20, 100, 200]);
  });
});

describe("byCost", () => {
  it("orders cheaper priced first", () => {
    const items = [
      metrics({ usage: { input: 0, output: 0, cost: 0.5 } }),
      metrics({ usage: { input: 0, output: 0, cost: 0.1 } }),
    ];
    const sorted = [...items].sort((a, b) => byCost(b) - byCost(a));
    expect(sorted.map((m) => m.usage.cost)).toEqual([0.1, 0.5]);
  });

  it("free (cost 0) sorts before any priced variant", () => {
    const items = [
      metrics({ usage: { input: 0, output: 0, cost: 0.01 } }),
      metrics({ usage: { input: 0, output: 0, cost: 0 } }),
    ];
    const sorted = [...items].sort((a, b) => byCost(b) - byCost(a));
    expect(sorted.map((m) => m.usage.cost)).toEqual([0, 0.01]);
  });

  it("unknown price (cost undefined) sorts last, after every priced variant", () => {
    const items = [
      metrics({ usage: { input: 0, output: 0 } }), // no cost field at all
      metrics({ usage: { input: 0, output: 0, cost: 5 } }),
    ];
    const sorted = [...items].sort((a, b) => byCost(b) - byCost(a));
    expect(sorted[0]?.usage.cost).toBe(5);
    expect(sorted[1]?.usage.cost).toBeUndefined();
  });
});
