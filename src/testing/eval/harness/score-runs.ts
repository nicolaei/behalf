// Harness — scoreRuns(). Shared by scenario.ts and explore.ts: score every run
// with one Scorer, fold the raw scores into a Distribution.

import type { Run } from "../../graph/run.js";
import type { Scorer } from "../scorers.js";
import type { Distribution } from "../regression.js";
import { aggregate } from "./aggregate.js";

export async function scoreRuns<World, Output = unknown>(
  scorer: Scorer<World, Output>,
  runs: Run<World, Output>[],
): Promise<{ scores: number[]; distribution: Distribution }> {
  const scores = await Promise.all(runs.map((run) => Promise.resolve(scorer.score(run))));
  const distribution = aggregate(scores, scorer.minimumScore);
  return { scores, distribution };
}
