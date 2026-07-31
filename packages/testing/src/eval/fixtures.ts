// Eval dataset — Fixtures, Example, example(). A row is a world, the fixtures
// that act on it, and the input that enters it.
//

import type { Message, Binding, ModelPort, Profile } from "@behalf-js/core";

/** The fakes acting on a world: fake tool bindings, and (in a graph test) a fake model port. `models` is a single port used regardless of which `Model` the flow requests, since a test fixture only ever has one script in play. @public */
export interface Fixtures {
  models?: ModelPort;
  bindings: Binding[];
}

/** One named row of an eval dataset. `fixtures` also receives the resolved `Profile` for that run — lets a fixture pick its fake model by `profile.model.identifier`, e.g. when `explore` sweeps variants. @public */
export interface Example<World = unknown> {
  name: string;
  world: () => World;
  fixtures: (world: World, profile: Profile) => Fixtures;
  input: Message;
}

/** Builds one dataset row. @public */
export function example<World>(
  name: string,
  row: {
    world: () => World;
    fixtures: (world: World, profile: Profile) => Fixtures;
    input: Message;
  },
): Example<World> {
  return { name, ...row };
}
