// Eval dataset — Fixtures, Example, example(). A row is a world, the fixtures
// that act on it, and the input that enters it.
//
// Stub only — the `example()` builder is trivial (just shapes its argument
// into an Example), but kept as a stub for Story 0 uniformity; no story
// currently gates behind it, so this may be filled in alongside Story 14/15.

import type { Message, Binding, ModelPort } from "../../index.js";

/** The fakes acting on a world: fake tool bindings, and (in a graph test) fake models. @public */
export interface Fixtures {
  models?: ModelPort[];
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
