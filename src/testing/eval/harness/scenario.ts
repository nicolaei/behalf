// Harness — scenario(). One behaviour, many worlds, shared scorers. Drives
// with runFlow (not the graph/ stepping primitives — evals never pause
// mid-flow), N times per row, folds each into a Run, scores, gates.

import { describe, it, expect } from "vitest";
import type { Message } from "../../../index.js";
import type { Subject } from "../subject.js";
import type { Example, Fixtures } from "../fixtures.js";
import type { Scorer } from "../scorers.js";
import type { Distribution, RegressionPolicy, BaselineStore } from "../regression.js";
import { checkRegression } from "../regression.js";
import { aggregate } from "./aggregate.js";
import { gate } from "./gate.js";
import { runRow } from "./run-row.js";

// Not barrel-exported from eval/index.ts — internal to the harness. A test
// author gets these shapes through scenario()'s return/argument inference,
// never by importing them directly.

/** One scorer's outcome from a scenario run. */
export interface ScenarioScorerResult {
  name: string;
  passed: boolean;
  distribution: Distribution;
  // Only present when `regression` + `baseline` are both configured and a
  // prior baseline existed for this scorer — independent of `passed`, which
  // only reflects this scorer's own bar.
  regressed?: boolean;
}

/** The result of running a scenario's rows/runs — what `scenario()` gates CI on. */
export interface ScenarioResult {
  passed: boolean;
  scorers: ScenarioScorerResult[];
}

/** Spec shared by `runScenario` and `scenario`. */
export interface ScenarioSpec<World, Output = unknown> {
  of: Subject<World, Output>;
  scorers: Scorer<World, Output>[];
  given?: Example<World>[];
  world?: () => World;
  fixtures?: (world: World) => Fixtures;
  input?: Message;
  runs?: number | { count: number; minimumPassRate: number };
  regression?: RegressionPolicy;
  // Where to read/write the per-scorer baseline this scenario's distributions
  // are compared against. Without it, `regression` is accepted but has
  // nothing to compare against — no check runs.
  baseline?: { store: BaselineStore; test: string };
}

/** Runs a scenario's rows x runs and returns its result — the directly-testable core, no test-runner registration. */
export async function runScenario<World, Output = unknown>(
  spec: ScenarioSpec<World, Output>,
): Promise<ScenarioResult> {
  const rows: Example<World>[] = spec.given ?? [
    {
      name: "default",
      world: requireField(spec.world, "world"),
      fixtures: requireField(spec.fixtures, "fixtures"),
      input: requireField(spec.input, "input"),
    },
  ];

  const count = typeof spec.runs === "number" ? spec.runs : (spec.runs?.count ?? 1);
  const globalMinimumPassRate =
    typeof spec.runs === "object" ? spec.runs.minimumPassRate : undefined;

  const runs = await Promise.all(
    rows.flatMap((row) =>
      Array.from({ length: count }, () => runRow<World, Output>(spec.of.profile, row, "scenario")),
    ),
  );

  const priorScorers = spec.baseline?.store.read(spec.baseline.test);

  const scorers: ScenarioScorerResult[] = await Promise.all(
    spec.scorers.map(async (scorer) => {
      const scores = await Promise.all(runs.map((run) => Promise.resolve(scorer.score(run))));
      const distribution = aggregate(scores, scorer.minimumScore);
      const result = gate({
        scores,
        minimumScore: scorer.minimumScore,
        minimumPassRate: scorer.minimumPassRate ?? globalMinimumPassRate ?? 1,
      });
      const priorDistribution = priorScorers?.[scorer.name];
      const regressed =
        spec.regression && priorDistribution !== undefined
          ? checkRegression(spec.regression, priorDistribution, distribution) === "fail"
          : undefined;
      return {
        name: scorer.name,
        passed: result.passed,
        distribution,
        ...(regressed !== undefined ? { regressed } : {}),
      };
    }),
  );

  const passed = scorers.every((s) => s.passed) && scorers.every((s) => !s.regressed);

  // Ratchet each scorer's own baseline forward independently — a scorer that
  // regressed (or failed its own bar) keeps its old baseline so it isn't
  // judged against its own bad run next time, but that shouldn't strand a
  // sibling scorer that passed and didn't regress from advancing too.
  if (spec.baseline) {
    const merged: Record<string, Distribution> = { ...priorScorers };
    for (const s of scorers) {
      if (s.passed && !s.regressed) merged[s.name] = s.distribution;
    }
    spec.baseline.store.write(spec.baseline.test, merged);
  }

  return { passed, scorers };
}

function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `scenario: "${name}" is required when "given" is omitted (need world/fixtures/input for the implicit default row)`,
    );
  }
  return value;
}

/** Registers a gating eval: passes when every scorer clears its bar on enough runs of every row. @public */
export function scenario<World, Output = unknown>(
  name: string,
  spec: ScenarioSpec<World, Output>,
): void {
  describe(name, () => {
    it("gates", async () => {
      const result = await runScenario(spec);
      expect(result.passed).toBe(true);
    });
  });
}
