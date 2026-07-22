// Eval regression — variance/fixed policies compared against a stored
// per-scorer Distribution, via a pluggable BaselineStore (JSONL by default).
//
// Stub only — see the epic's Story 11 architecture note for the concrete
// behaviour each earns.

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

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Compares `current` against `baseline` under `policy`. @public */
export function checkRegression(
  policy: RegressionPolicy,
  baseline: Distribution,
  current: Distribution,
): "pass" | "fail" {
  void policy;
  void baseline;
  void current;
  return notImplemented("checkRegression");
}

/** Per-scorer Distribution from the last accepted run, keyed by test name. @public */
export interface BaselineStore {
  read(test: string): Record<string, Distribution> | undefined;
  write(test: string, scorers: Record<string, Distribution>): void;
}

/** The default BaselineStore adapter — one JSON object per line, keyed by test name. @public */
export function jsonlBaselineStore(path: string): BaselineStore {
  void path;
  return notImplemented("jsonlBaselineStore");
}
