// Internal helper shared by scenario.ts and explore.ts — runs one Example
// row once against a resolved Profile, folding the result into a Run.
// Not exported from eval/index.ts — an implementation detail.

import { runtime, runFlow, adapters } from "../../../index.js";
import type { Profile } from "../../../index.js";
import type { Example } from "../fixtures.js";
import { agentGraph } from "./agent-graph.js";
import { foldRun } from "../../graph/run.js";
import type { Run } from "../../graph/run.js";

/** Runs `row` once against `profile`: fresh world, fresh fixtures, fresh runtime and store, so every call is fully independent of every other. */
export async function runRow<World, Output>(
  profile: Profile,
  row: Example<World>,
  callerName: string,
): Promise<Run<World, Output>> {
  const started = Date.now();
  const world = row.world();
  const fixtures = row.fixtures(world, profile);
  const ready = await runtime({
    models: () => fixtures.models ?? throwNoModelConfigured(callerName),
    bindings: fixtures.bindings,
    store: adapters.stores.memoryStore(),
  });
  await runFlow(agentGraph(profile), row.input, ready);
  const latency = Date.now() - started;
  return foldRun<World, Output>(ready.store.events(), world, latency);
}

function throwNoModelConfigured(callerName: string): never {
  throw new Error(
    `${callerName}: no model fixture configured — fixtures(world, profile) must return a \`models\` port for a graph test`,
  );
}
