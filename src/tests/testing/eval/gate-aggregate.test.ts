import { describe, it, expect } from "vitest";
import { gate } from "../../../testing/eval/harness/gate.js";
import { aggregate } from "../../../testing/eval/harness/aggregate.js";

describe("gate", () => {
  it("passes when the pass-rate clears the required rate", () => {
    const result = gate({ scores: [1, 1, 1, 1, 0], minimumScore: 1, minimumPassRate: 0.8 });
    expect(result.passed).toBe(true);
    expect(result.passRate).toBe(0.8);
  });

  it("fails when the pass-rate misses the required rate", () => {
    const result = gate({ scores: [1, 1, 0, 0, 0], minimumScore: 1, minimumPassRate: 0.9 });
    expect(result.passed).toBe(false);
  });
});

describe("aggregate", () => {
  it("computes mean/median/stddev/min/max/passRate from a raw score array", () => {
    const dist = aggregate([0.8, 0.9, 1.0, 0.9, 0.85], 0.85);
    expect(dist.mean).toBeCloseTo(0.89, 2);
    expect(dist.min).toBe(0.8);
    expect(dist.max).toBe(1.0);
    expect(dist.passRate).toBeCloseTo(0.8, 5); // 4 of 5 scores >= 0.85
  });
});
