import { describe, it, expect } from "vitest";
import { gate } from "../../eval/harness/gate.js";
import { mean, aggregate } from "../../eval/harness/aggregate.js";

describe("gate", () => {
  it("passes when every score clears minimumScore", () => {
    const result = gate({ scores: [1, 1, 1], minimumScore: 1, minimumPassRate: 1 });
    expect(result).toEqual({ passed: true, passRate: 1 });
  });

  it("computes passRate as the fraction of scores at or above minimumScore", () => {
    const result = gate({ scores: [1, 0, 1, 0], minimumScore: 1, minimumPassRate: 1 });
    expect(result.passRate).toBe(0.5);
  });

  it("passes at exactly the minimumPassRate boundary", () => {
    const result = gate({ scores: [1, 1, 0], minimumScore: 1, minimumPassRate: 2 / 3 });
    expect(result.passed).toBe(true);
  });

  it("fails just below the minimumPassRate boundary", () => {
    const result = gate({ scores: [1, 0, 0], minimumScore: 1, minimumPassRate: 0.5 });
    expect(result.passed).toBe(false);
  });

  it("treats an empty scores array as a 0 passRate, never dividing by zero", () => {
    const result = gate({ scores: [], minimumScore: 1, minimumPassRate: 0 });
    expect(result).toEqual({ passed: true, passRate: 0 });
  });

  it("a score exactly at minimumScore counts as passing", () => {
    const result = gate({ scores: [0.8], minimumScore: 0.8, minimumPassRate: 1 });
    expect(result.passed).toBe(true);
  });
});

describe("mean", () => {
  it("averages a non-empty array", () => {
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("is 0 for an empty array, not NaN", () => {
    expect(mean([])).toBe(0);
    expect(Number.isNaN(mean([]))).toBe(false);
  });
});

describe("aggregate", () => {
  it("folds a score array into mean/median/stddev/min/max/passRate", () => {
    const distribution = aggregate([1, 2, 3, 4], 3);
    expect(distribution.mean).toBe(2.5);
    expect(distribution.median).toBe(2.5);
    expect(distribution.min).toBe(1);
    expect(distribution.max).toBe(4);
    expect(distribution.passRate).toBe(0.5); // 3 and 4 clear the bar of 3
    expect(distribution.stddev).toBeCloseTo(Math.sqrt(1.25), 10);
  });

  it("median of an odd-length array is the middle value", () => {
    expect(aggregate([5, 1, 3], 0).median).toBe(3);
  });

  it("stddev of a constant array is 0", () => {
    const distribution = aggregate([2, 2, 2], 2);
    expect(distribution.stddev).toBe(0);
    expect(distribution.passRate).toBe(1);
  });

  it("empty scores fold to all-zero, not NaN", () => {
    const distribution = aggregate([], 1);
    expect(distribution).toEqual({ mean: 0, median: 0, stddev: 0, min: 0, max: 0, passRate: 0 });
  });
});
