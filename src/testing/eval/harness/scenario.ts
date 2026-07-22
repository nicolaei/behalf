// Harness — scenario(). One behaviour, many worlds, shared scorers. Drives
// with runFlow (not the graph/ stepping primitives — evals never pause
// mid-flow), N times per row, folds each into a Run, scores, gates.

import { describe, it, expect } from "vitest";
import type { Message } from "../../../index.js";
import type { Subject } from "../subject.js";
import type { Example, Fixtures } from "../fixtures.js";
import type { Scorer } from "../scorers.js";
import type { Distribution, RegressionPolicy } from "../regression.js";
import { aggregate } from "./aggregate.js";
import { gate } from "./gate.js";
import { runRow } from "./run-row.js";

/** One scorer's outcome from a scenario run. @public */
export interface ScenarioScorerResult {
  name: string;
  passed: boolean;
  distribution: Distribution;
}

/** The result of running a scenario's rows/runs — what `scenario()` gates CI on. @public */
export interface ScenarioResult {
  passed: boolean;
  scorers: ScenarioScorerResult[];
}

/** Spec shared by `runScenario` and `scenario`. @public */
export interface ScenarioSpec<World, Output = unknown> {
  of: Subject<World, Output>;
  scorers: Scorer<World, Output>[];
  given?: Example<World>[];
  world?: () => World;
  fixtures?: (world: World) => Fixtures;
  input?: Message;
  runs?: number | { count: number; minimumPassRate: number };
  regression?: RegressionPolicy;
}

/** Runs a scenario's rows x runs and returns its result — the directly-testable core, no test-runner registration. @public */
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

  const scorers: ScenarioScorerResult[] = await Promise.all(
    spec.scorers.map(async (scorer) => {
      const scores = await Promise.all(runs.map((run) => Promise.resolve(scorer.score(run))));
      const distribution = aggregate(scores, scorer.minimumScore);
      const result = gate({
        scores,
        minimumScore: scorer.minimumScore,
        minimumPassRate: scorer.minimumPassRate ?? globalMinimumPassRate ?? 1,
      });
      return { name: scorer.name, passed: result.passed, distribution };
    }),
  );

  // regression: out of scope for this story — the spec has no BaselineStore/test-name
  // parameter to load/save a baseline against. Accepted but not persisted; a later
  // story can wire it once scenario() carries enough identity to key a baseline by.
  void spec.regression;

  return { passed: scorers.every((s) => s.passed), scorers };
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
