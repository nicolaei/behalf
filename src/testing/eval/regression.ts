// Eval regression — variance/fixed policies compared against a stored
// per-scorer Distribution, via a pluggable BaselineStore (JSONL by default).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** A scorer's score distribution across a scenario's runs. @public */
export interface Distribution {
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
  passRate: number;
}

/** How a scenario decides its scores haven't regressed against the baseline. @public */
export type RegressionPolicy =
  { kind: "variance"; k?: number } | { kind: "fixed"; epsilon: number };

/** Fail if median < baseline.median − k·stddev (default k = 1). @public */
export function variance(k?: number): RegressionPolicy {
  return { kind: "variance", ...(k !== undefined ? { k } : {}) };
}

/** Fail if mean < baseline.mean − epsilon. @public */
export function fixed(epsilon: number): RegressionPolicy {
  return { kind: "fixed", epsilon };
}

/** Compares `current` against `baseline` under `policy`. @public */
export function checkRegression(
  policy: RegressionPolicy,
  baseline: Distribution,
  current: Distribution,
): "pass" | "fail" {
  if (policy.kind === "variance") {
    const threshold = baseline.median - (policy.k ?? 1) * baseline.stddev;
    return current.median < threshold ? "fail" : "pass";
  }
  const threshold = baseline.mean - policy.epsilon;
  return current.mean < threshold ? "fail" : "pass";
}

/** Per-scorer Distribution from the last accepted run, keyed by test name. @public */
export interface BaselineStore {
  read(test: string): Record<string, Distribution> | undefined;
  write(test: string, scorers: Record<string, Distribution>): void;
}

/** The default BaselineStore adapter — one JSON object per line, keyed by test name. Append-only; read() returns the last matching line (last-write-wins). @public */
export function jsonlBaselineStore(path: string): BaselineStore {
  interface Entry {
    test: string;
    scorers: Record<string, Distribution>;
  }

  function readAll(): Entry[] {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Entry);
  }

  return {
    read(test: string): Record<string, Distribution> | undefined {
      const entries = readAll().filter((e) => e.test === test);
      return entries.length > 0 ? entries[entries.length - 1]?.scorers : undefined;
    },
    write(test: string, scorers: Record<string, Distribution>): void {
      const line = `${JSON.stringify({ test, scorers })}\n`;
      if (!existsSync(path)) {
        writeFileSync(path, line);
      } else {
        appendFileSync(path, line);
      }
    },
  };
}
