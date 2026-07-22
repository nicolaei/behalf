// Eval subjects — Subject/Agent. Pure — no engine, no Run. The thing under
// eval: an agent, a single step, or a fake tool handler, all carrying a
// Profile. `Agent.with` re-profiles it — what `explore` varies.
//
// Stub only — see the epic's Story 8 architecture note for the concrete
// behaviour this earns.

import type { Profile } from "../../index.js";

/** The thing under eval — an agent, a single step, or a fake tool handler. @public */
export interface Subject<World = unknown, Output = unknown> {
  readonly name: string;
  readonly profile: Profile;
  readonly __types?: (world: World) => Output;
}

/** A Subject that can be re-profiled — what `explore` sweeps across variants. @public */
export interface Agent<World = unknown, Output = unknown> extends Subject<World, Output> {
  with(profile: Partial<Profile>): Subject<World, Output>;
}

/** Builds an `Agent` — the thing under eval, carrying `profile`. `.with(partial)` re-profiles it without mutating the original. @public */
export function agent<World = unknown, Output = unknown>(
  name: string,
  profile: Profile,
): Agent<World, Output> {
  return {
    name,
    profile,
    with(partial: Partial<Profile>): Subject<World, Output> {
      return { name, profile: { ...profile, ...partial } };
    },
  };
}
