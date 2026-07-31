import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { variance, fixed, checkRegression, jsonlBaselineStore } from "../../eval/regression.js";
import type { Distribution } from "../../eval/regression.js";

function distribution(overrides: Partial<Distribution>): Distribution {
  return { mean: 1, median: 1, stddev: 0, min: 1, max: 1, passRate: 1, ...overrides };
}

describe("variance", () => {
  it("defaults k to 1 when omitted", () => {
    expect(variance()).toEqual({ kind: "variance" });
  });

  it("carries an explicit k", () => {
    expect(variance(2)).toEqual({ kind: "variance", k: 2 });
  });
});

describe("fixed", () => {
  it("carries its epsilon", () => {
    expect(fixed(0.1)).toEqual({ kind: "fixed", epsilon: 0.1 });
  });
});

describe("checkRegression", () => {
  it("variance policy: fails when current.median falls below baseline.median - k*stddev", () => {
    const baseline = distribution({ median: 10, stddev: 2 });
    const current = distribution({ median: 7 }); // 10 - 1*2 = 8, 7 < 8
    expect(checkRegression({ kind: "variance", k: 1 }, baseline, current)).toBe("fail");
  });

  it("variance policy: passes exactly at the threshold", () => {
    const baseline = distribution({ median: 10, stddev: 2 });
    const current = distribution({ median: 8 }); // exactly the threshold
    expect(checkRegression({ kind: "variance", k: 1 }, baseline, current)).toBe("pass");
  });

  it("variance policy: defaults k to 1 when omitted from the policy", () => {
    const baseline = distribution({ median: 10, stddev: 2 });
    const current = distribution({ median: 9 }); // 10 - 1*2 = 8, 9 >= 8
    expect(checkRegression({ kind: "variance" }, baseline, current)).toBe("pass");
  });

  it("fixed policy: fails when current.mean falls below baseline.mean - epsilon", () => {
    const baseline = distribution({ mean: 10 });
    const current = distribution({ mean: 8.9 });
    expect(checkRegression({ kind: "fixed", epsilon: 1 }, baseline, current)).toBe("fail");
  });

  it("fixed policy: passes exactly at the threshold", () => {
    const baseline = distribution({ mean: 10 });
    const current = distribution({ mean: 9 });
    expect(checkRegression({ kind: "fixed", epsilon: 1 }, baseline, current)).toBe("pass");
  });
});

describe("jsonlBaselineStore", () => {
  it("read() returns undefined when nothing has been written for that test", () => {
    const path = join(tmpdir(), `baseline-${String(Date.now())}-${String(Math.random())}.jsonl`);
    const store = jsonlBaselineStore(path);
    expect(store.read("some-test")).toBeUndefined();
  });

  it("round-trips a write through read()", () => {
    const path = join(tmpdir(), `baseline-${String(Date.now())}-${String(Math.random())}.jsonl`);
    try {
      const store = jsonlBaselineStore(path);
      const scorers = { toolCalled: distribution({ mean: 0.9 }) };
      store.write("my-test", scorers);
      expect(store.read("my-test")).toEqual(scorers);
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });

  it("creates the file on first write", () => {
    const path = join(tmpdir(), `baseline-${String(Date.now())}-${String(Math.random())}.jsonl`);
    try {
      expect(existsSync(path)).toBe(false);
      jsonlBaselineStore(path).write("t", { s: distribution({}) });
      expect(existsSync(path)).toBe(true);
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });

  it("last-write-wins for a repeated test key, appending rather than overwriting the file", () => {
    const path = join(tmpdir(), `baseline-${String(Date.now())}-${String(Math.random())}.jsonl`);
    try {
      const store = jsonlBaselineStore(path);
      store.write("my-test", { s: distribution({ mean: 1 }) });
      store.write("my-test", { s: distribution({ mean: 2 }) });
      expect(store.read("my-test")).toEqual({ s: distribution({ mean: 2 }) });
      // append-only: two lines on disk, not one overwritten line
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(2);
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });

  it("keeps separate tests' baselines independent", () => {
    const path = join(tmpdir(), `baseline-${String(Date.now())}-${String(Math.random())}.jsonl`);
    try {
      const store = jsonlBaselineStore(path);
      store.write("test-a", { s: distribution({ mean: 1 }) });
      store.write("test-b", { s: distribution({ mean: 2 }) });
      expect(store.read("test-a")).toEqual({ s: distribution({ mean: 1 }) });
      expect(store.read("test-b")).toEqual({ s: distribution({ mean: 2 }) });
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });
});
