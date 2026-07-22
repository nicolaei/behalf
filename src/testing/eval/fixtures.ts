// Eval dataset — Fixtures, Example, example(). A row is a world, the fixtures
// that act on it, and the input that enters it.
//
// Stub only — the `example()` builder is trivial (just shapes its argument
// into an Example), but kept as a stub for Story 0 uniformity; no story
// currently gates behind it, so this may be filled in alongside Story 14/15.

import type { Message, Binding, ModelPort } from "../../index.js";

/** The fakes acting on a world: fake tool bindings, and (in a graph test) a fake model port. `models` is a single port — same convention as `runtime({models: () => scriptedPort, ...})` elsewhere — used regardless of which `Model` the flow requests, since a test fixture only ever has one script in play. @public */
export interface Fixtures {
  models?: ModelPort;
  bindings: Binding[];
}

/** One named row of an eval dataset. @public */
export interface Example<World = unknown> {
  name: string;
  world: () => World;
  fixtures: (world: World) => Fixtures;
  input: Message;
}

/** Builds one dataset row. @public */
export function example<World>(
  name: string,
  row: { world: () => World; fixtures: (world: World) => Fixtures; input: Message },
): Example<World> {
  return { name, ...row };
}
