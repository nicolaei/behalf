import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Distribution } from "../../../testing/eval/regression.js";
import {
  variance,
  fixed,
  checkRegression,
  jsonlBaselineStore,
} from "../../../testing/eval/regression.js";

describe("regression policies", () => {
  it("variance fails when the current median drops more than k·stddev below baseline", () => {
    const baseline: Distribution = {
      mean: 0.9,
      median: 0.91,
      stddev: 0.04,
      min: 0.8,
      max: 1,
      passRate: 1,
    };
    const current: Distribution = {
      mean: 0.82,
      median: 0.83,
      stddev: 0.02,
      min: 0.7,
      max: 0.9,
      passRate: 0.8,
    };
    expect(checkRegression(variance(1), baseline, current)).toBe("fail"); // 0.83 < 0.91 - 0.04
  });

  it("variance passes within the allowed spread", () => {
    const baseline: Distribution = {
      mean: 0.9,
      median: 0.9,
      stddev: 0.05,
      min: 0.8,
      max: 1,
      passRate: 1,
    };
    const current: Distribution = {
      mean: 0.87,
      median: 0.87,
      stddev: 0.03,
      min: 0.8,
      max: 0.95,
      passRate: 0.9,
    };
    expect(checkRegression(variance(1), baseline, current)).toBe("pass"); // 0.87 >= 0.9 - 0.05
  });

  it("fixed fails on any drop past a hard epsilon", () => {
    const baseline: Distribution = { mean: 1, median: 1, stddev: 0, min: 1, max: 1, passRate: 1 };
    const current: Distribution = {
      mean: 0.9,
      median: 0.9,
      stddev: 0,
      min: 0.9,
      max: 0.9,
      passRate: 1,
    };
    expect(checkRegression(fixed(0.05), baseline, current)).toBe("fail");
  });
});

describe("BaselineStore JSONL adapter", () => {
  let dir: string;
  let tmpPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "behalf-baseline-"));
    tmpPath = join(dir, "baseline.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips read/write", () => {
    const store = jsonlBaselineStore(tmpPath);
    store.write("my-test", {
      toolCalled: { mean: 1, median: 1, stddev: 0, min: 1, max: 1, passRate: 1 },
    });
    expect(store.read("my-test")).toEqual({
      toolCalled: { mean: 1, median: 1, stddev: 0, min: 1, max: 1, passRate: 1 },
    });
  });

  it("read returns undefined for an unknown test", () => {
    expect(jsonlBaselineStore(tmpPath).read("never-seen")).toBeUndefined();
  });

  it("last-write-wins when the same test is written twice (append-only log)", () => {
    const store = jsonlBaselineStore(tmpPath);
    store.write("my-test", {
      toolCalled: { mean: 1, median: 1, stddev: 0, min: 1, max: 1, passRate: 1 },
    });
    store.write("my-test", {
      toolCalled: { mean: 2, median: 2, stddev: 0, min: 2, max: 2, passRate: 1 },
    });
    expect(store.read("my-test")?.["toolCalled"]?.mean).toBe(2);
  });

  it("a second write for a different test doesn't clobber the first (both readable)", () => {
    const store = jsonlBaselineStore(tmpPath);
    store.write("test-a", { s: { mean: 1, median: 1, stddev: 0, min: 1, max: 1, passRate: 1 } });
    store.write("test-b", { s: { mean: 2, median: 2, stddev: 0, min: 2, max: 2, passRate: 1 } });
    expect(store.read("test-a")?.["s"]?.mean).toBe(1);
    expect(store.read("test-b")?.["s"]?.mean).toBe(2);
  });
});
