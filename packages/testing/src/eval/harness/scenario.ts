// Harness — scenario(). One behaviour, many worlds, shared scorers. Drives
// with runFlow (not the graph/ stepping primitives — evals never pause
// mid-flow), N times per row, folds each into a Run, scores, gates.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { Message } from "@behalf-js/core";
import type { Subject } from "../subject.js";
import type { Example, Fixtures } from "../fixtures.js";
import type { Scorer } from "../scorers.js";
import type { Distribution, RegressionPolicy, BaselineStore } from "../regression.js";

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
  _spec: ScenarioSpec<World, Output>,
): Promise<ScenarioResult> {
  throw new Error("not implemented");
}

/** Registers a gating eval: passes when every scorer clears its bar on enough runs of every row. @public */
export function scenario<World, Output = unknown>(
  _name: string,
  _spec: ScenarioSpec<World, Output>,
): void {
  throw new Error("not implemented");
}
