// Harness — explore(). A scenario with many variants instead of one — ranks,
// never gates CI.

import { describe, it } from "vitest";
import type { Profile } from "../../../index.js";
import type { Agent } from "../subject.js";
import type { Example } from "../fixtures.js";
import type { Scorer } from "../scorers.js";
import type { Distribution } from "../regression.js";
import { mean } from "./aggregate.js";
import { scoreRuns } from "./score-runs.js";
import type { Metrics, Rank } from "./rank.js";
import { byScore } from "./rank.js";
import { runRow } from "./run-row.js";

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
  rankBy?: Rank;
}

/** One variant's ranked outcome. */
export interface ExploreVariantResult {
  profile: Partial<Profile>;
  metrics: Metrics;
  scorers: { name: string; distribution: Distribution }[];
}

/** The result of exploring every variant — sorted by `rankBy`, highest rank first. */
export interface ExploreResult {
  variants: ExploreVariantResult[];
}

/** Runs every variant's rows x runs and returns them ranked — the directly-testable core, no test-runner registration. */
export async function runExplore<World, Output = unknown>(
  spec: ExploreSpec<World, Output>,
): Promise<ExploreResult> {
  const count = typeof spec.runs === "number" ? spec.runs : (spec.runs?.count ?? 1);
  const rankBy = spec.rankBy ?? byScore;
  // spec.runs.minimumPassRate (if given) is accepted for parity with scenario's spec
  // shape but has no effect here — explore never gates, it only ranks.

  const variants = await Promise.all(
    spec.variants.map(async (variant) => {
      const subject = spec.of.with(variant);
      const runs = await Promise.all(
        spec.given.flatMap((row) =>
          Array.from({ length: count }, () =>
            runRow<World, Output>(subject.profile, row, "explore"),
          ),
        ),
      );

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
        latency: mean(runs.map((r) => r.latency)),
      };

      return { profile: variant, metrics, scorers };
    }),
  );

  variants.sort((a, b) => rankBy(b.metrics) - rankBy(a.metrics));

  return { variants };
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
