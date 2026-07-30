// Harness — explore(). A scenario with many variants instead of one — ranks,
// never gates CI.
//
// `rankBy` accepts either one `Rank` or a named map of them — a map doesn't
// re-run anything, it just sorts the same computed variants once per entry.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { Profile } from "@behalf-js/core";
import type { Agent } from "../subject.js";
import type { Example } from "../fixtures.js";
import type { Scorer } from "../scorers.js";
import type { Distribution } from "../regression.js";
import type { Metrics, Rank } from "./rank.js";

// Not barrel-exported from eval/index.ts — internal to the harness. A test
// author gets these shapes through explore()'s return/argument inference,
// never by importing them directly.

/** Spec shared by `runExplore` and `explore`. */
export interface ExploreSpec<World, Output = unknown> {
  of: Agent<World, Output>;
  variants: Partial<Profile>[];
  scorers: Scorer<World, Output>[];
  given: Example<World>[];
  runs?: number | { count: number; minimumPassRate: number };
  rankBy?: Rank | Record<string, Rank>;
}

/** One variant's ranked outcome. */
export interface ExploreVariantResult {
  profile: Partial<Profile>;
  metrics: Metrics;
  scorers: { name: string; distribution: Distribution }[];
}

/** The result of exploring every variant — unsorted truth, plus one sorted array per named `rankBy` entry (key "default" when `rankBy` was a single `Rank`). Nothing re-runs to produce more than one ranking. */
export interface ExploreResult {
  variants: ExploreVariantResult[];
  rankings: Record<string, ExploreVariantResult[]>;
}

/** Runs every variant's rows x runs and returns them ranked — the directly-testable core, no test-runner registration. */
export async function runExplore<World, Output = unknown>(
  _spec: ExploreSpec<World, Output>,
): Promise<ExploreResult> {
  throw new Error("not implemented");
}

/** Registers a ranking eval across variants — never fails CI. @public */
export function explore<World, Output = unknown>(
  _name: string,
  _spec: ExploreSpec<World, Output>,
): void {
  throw new Error("not implemented");
}
