// Harness — aggregate(). Pure: a raw score array folded into a Distribution.

import type { Distribution } from "../regression.js";

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted.at(mid - 1) ?? 0;
  const at = sorted.at(mid) ?? 0;
  return sorted.length % 2 === 0 ? (lower + at) / 2 : at;
}

/** Folds a raw score array into mean/median/stddev/min/max/passRate. `minimumScore` is the bar passRate is computed against. @public */
export function aggregate(scores: number[], minimumScore: number): Distribution {
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const passRate = scores.filter((s) => s >= minimumScore).length / scores.length;
  return {
    mean,
    median: median(sorted),
    stddev: Math.sqrt(variance),
    min: sorted.at(0) ?? 0,
    max: sorted.at(-1) ?? 0,
    passRate,
  };
}
