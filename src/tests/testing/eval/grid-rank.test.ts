import { describe, it, expect } from "vitest";
import type { Model } from "../../../index.js";
import { grid, byScore, byLatency, byTokens, byCost } from "../../../testing/eval/harness/rank.js";

describe("grid", () => {
  const qwen: Model = { identifier: "qwen", provider: "test", contextWindow: 1000, reasoning: [] };
  const sonnet: Model = {
    identifier: "sonnet",
    provider: "test",
    contextWindow: 1000,
    reasoning: [],
  };

  it("produces the cross-product of every axis's values", () => {
    const variants = grid({ model: [qwen, sonnet], reasoning: ["low", "high"] });
    expect(variants).toHaveLength(4);
    expect(variants).toContainEqual({ model: qwen, reasoning: "low" });
    expect(variants).toContainEqual({ model: sonnet, reasoning: "high" });
  });
});

describe("rank functions", () => {
  it("byScore sorts higher score first", () => {
    const metrics = [
      { score: 0.7, usage: { input: 0, output: 0 }, latency: 0 },
      { score: 0.9, usage: { input: 0, output: 0 }, latency: 0 },
    ];
    expect(metrics.map(byScore).sort((a, b) => b - a)).toEqual([0.9, 0.7]);
  });

  it("byCost ranks free before priced, priced before unknown", () => {
    const free = byCost({ score: 0, usage: { input: 0, output: 0, cost: 0 }, latency: 0 });
    const priced = byCost({ score: 0, usage: { input: 0, output: 0, cost: 0.02 }, latency: 0 });
    const unknown = byCost({ score: 0, usage: { input: 0, output: 0 }, latency: 0 });
    expect(free).toBeGreaterThan(priced);
    expect(priced).toBeGreaterThan(unknown);
  });

  it("byLatency/byTokens rank lower first", () => {
    expect(byLatency({ score: 0, usage: { input: 0, output: 0 }, latency: 100 })).toBeGreaterThan(
      byLatency({ score: 0, usage: { input: 0, output: 0 }, latency: 500 }),
    );
    expect(byTokens({ score: 0, usage: { input: 10, output: 10 }, latency: 0 })).toBeGreaterThan(
      byTokens({ score: 0, usage: { input: 100, output: 100 }, latency: 0 }),
    );
  });
});
