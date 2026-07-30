// Harness — explore(). A scenario with many variants instead of one — ranks,
// never gates CI.
//
// `rankBy` accepts either one `Rank` or a named map of them — a map doesn't
// re-run anything, it just sorts the same computed variants once per entry.

import { describe, it } from "vitest";
import type { Profile } from "@behalf-js/core";
import type { Agent } from "../subject.js";
import type { Example } from "../fixtures.js";
import type { Scorer } from "../scorers.js";
import type { Distribution } from "../regression.js";
import { mean } from "./aggregate.js";
import { scoreRuns } from "./score-runs.js";
import type { Metrics, Rank } from "./rank.js";
import { byScore } from "./rank.js";
import { runRows } from "./run-row.js";

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

/** The result of exploring every variant — unsorted truth, plus one sorted array per named `rankBy` entry (key "default" when `rankBy` was a single `Rank`). `RankNames` is inferred at the call site from the shape of `rankBy` so the ranking keys are literal properties, not a plain string index signature — that's what lets `result.rankings.quality` type-check without bracket notation. Nothing re-runs to produce more than one ranking. */
export interface ExploreResult<RankNames extends string = "default"> {
  variants: ExploreVariantResult[];
  rankings: Record<RankNames, ExploreVariantResult[]>;
}

/** Runs every variant's rows x runs and returns them ranked — the directly-testable core, no test-runner registration. Overloaded so a named `rankBy` map infers `RankNames` as the literal union of its keys (via the exact object type of the argument, not the widened `Record<string, Rank>`), while a single `Rank` (or an omitted `rankBy`) resolves to the single `"default"` key. */
export async function runExplore<World, Output, RankBy extends Record<string, Rank>>(
  spec: Omit<ExploreSpec<World, Output>, "rankBy"> & { rankBy: RankBy },
): Promise<ExploreResult<Extract<keyof RankBy, string>>>;
export async function runExplore<World, Output = unknown>(
  spec: ExploreSpec<World, Output>,
): Promise<ExploreResult<"default">>;
export async function runExplore<World, Output>(
  spec: ExploreSpec<World, Output>,
): Promise<ExploreResult<string>> {
  const count = typeof spec.runs === "number" ? spec.runs : (spec.runs?.count ?? 1);
  // spec.runs.minimumPassRate (if given) is accepted for parity with scenario's spec
  // shape but has no effect here — explore never gates, it only ranks.

  const variants: ExploreVariantResult[] = await Promise.all(
    spec.variants.map(async (variant) => {
      const subject = spec.of.with(variant);
      const runs = await runRows<World, Output>(subject.profile, spec.given, count, "explore");

      const scorers = await Promise.all(
        spec.scorers.map(async (scorer) => {
          const { distribution } = await scoreRuns(scorer, runs);
          return { name: scorer.name, distribution };
        }),
      );

      const metrics: Metrics = {
        score: mean(scorers.map((s) => s.distribution.mean)),
        usage: {
          input: mean(runs.map((r) => r.usage.input)),
          output: mean(runs.map((r) => r.usage.output)),
        },
        timeToComplete: mean(runs.map((r) => r.latency)),
      };

      return { profile: variant, metrics, scorers };
    }),
  );

  const rankers: Record<string, Rank> =
    spec.rankBy === undefined
      ? { default: byScore }
      : typeof spec.rankBy === "function"
        ? { default: spec.rankBy }
        : spec.rankBy;

  const rankings: Record<string, ExploreVariantResult[]> = {};
  for (const [name, rank] of Object.entries(rankers)) {
    rankings[name] = [...variants].sort((a, b) => rank(b.metrics) - rank(a.metrics));
  }

  return { variants, rankings };
}

/** Registers a ranking eval across variants — never fails CI. @public */
export function explore<World, Output = unknown>(
  name: string,
  spec: ExploreSpec<World, Output>,
): void {
  describe(name, () => {
    it("ranks", async () => {
      await runExplore(spec);
    });
  });
}
