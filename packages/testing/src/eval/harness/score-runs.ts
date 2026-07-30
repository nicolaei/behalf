// Harness — scoreRuns(). Shared by scenario.ts and explore.ts: score every run
// with one Scorer, fold the raw scores into a Distribution.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { Run } from "../run.js";
import type { Scorer } from "../scorers.js";
import type { Distribution } from "../regression.js";

export async function scoreRuns<World, Output = unknown>(
  _scorer: Scorer<World, Output>,
  _runs: Run<World, Output>[],
): Promise<{ scores: number[]; distribution: Distribution }> {
  throw new Error("not implemented");
}
