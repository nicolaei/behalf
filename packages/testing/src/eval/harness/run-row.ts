// Internal helpers shared by scenario.ts and explore.ts — runRow() runs one
// Example row once against a resolved Profile, folding the result into a
// Run; runRows() repeats that `count` times across every row in `rows`, the
// "rows x runs" shape both harnesses drive before scoring diverges.
// Not exported from eval/index.ts — an implementation detail.

import { runtime, runFlow } from "@behalf-js/core";
import type { Profile } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import type { Example } from "../fixtures.js";
import { agentGraph } from "./agent-graph.js";
import { foldRun } from "../run.js";
import type { Run } from "../run.js";

/** Runs `row` once against `profile`: fresh world, fresh fixtures, fresh runtime and store, so every call is fully independent of every other. */
export async function runRow<World, Output>(
  profile: Profile,
  row: Example<World>,
  callerName: string,
): Promise<Run<World, Output>> {
  const started = Date.now();
  const world = row.world();
  const fixtures = row.fixtures(world, profile);
  if (fixtures.models === undefined) {
    throw new Error(
      `${callerName}: no model fixture configured — fixtures(world, profile) must return a \`models\` port for a graph test`,
    );
  }
  const models = fixtures.models;
  const ready = await runtime({
    models: () => models,
    bindings: fixtures.bindings,
    store: memoryStore(),
  });
  await runFlow(agentGraph(profile), row.input, ready);
  const latency = Date.now() - started;
  return foldRun<World, Output>(ready.store.events(), world, latency);
}

/** Runs every row in `rows` `count` times against `profile`, in parallel. */
export function runRows<World, Output>(
  profile: Profile,
  rows: Example<World>[],
  count: number,
  callerName: string,
): Promise<Run<World, Output>[]> {
  return Promise.all(
    rows.flatMap((row) =>
      Array.from({ length: count }, () => runRow<World, Output>(profile, row, callerName)),
    ),
  );
}
