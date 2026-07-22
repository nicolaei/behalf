// Harness — aggregate(). Pure: a raw score array folded into a Distribution.

import type { Distribution } from "../regression.js";

// Shared with explore.ts's per-variant metric folding — one empty-array
// convention (0, not NaN) for every mean in this package.
export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted.at(mid - 1) ?? 0;
  const at = sorted.at(mid) ?? 0;
  return sorted.length % 2 === 0 ? (lower + at) / 2 : at;
}

/** Folds a raw score array into mean/median/stddev/min/max/passRate. `minimumScore` is the bar passRate is computed against. @public */
export function aggregate(scores: number[], minimumScore: number): Distribution {
  const sorted = [...scores].sort((a, b) => a - b);
  const scoreMean = mean(scores);
  const variance =
    scores.length === 0
      ? 0
      : scores.reduce((sum, s) => sum + (s - scoreMean) ** 2, 0) / scores.length;
  const passRate =
    scores.length === 0 ? 0 : scores.filter((s) => s >= minimumScore).length / scores.length;
  return {
    mean: scoreMean,
    median: median(sorted),
    stddev: Math.sqrt(variance),
    min: sorted.at(0) ?? 0,
    max: sorted.at(-1) ?? 0,
    passRate,
  };
}
