// Internal helper shared by scenario.ts and explore.ts — runs one Example
// row once against a resolved Profile, folding the result into a Run.
//
// Not exported from eval/index.ts — an implementation detail.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { Profile } from "@behalf-js/core";
import type { Example } from "../fixtures.js";
import type { Run } from "../run.js";

/** Runs `row` once against `profile`: fresh world, fresh fixtures, fresh runtime and store, so every call is fully independent of every other. */
export async function runRow<World, Output>(
  _profile: Profile,
  _row: Example<World>,
  _callerName: string,
): Promise<Run<World, Output>> {
  throw new Error("not implemented");
}
