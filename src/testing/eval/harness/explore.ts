// Harness — explore(). A scenario with many variants instead of one — ranks,
// never gates CI.
//
// Stub only — see the epic's Story 15 architecture note for the concrete
// behaviour this earns.

import type { Profile } from "../../../index.js";
import type { Agent } from "../subject.js";
import type { Example } from "../fixtures.js";
import type { Scorer } from "../scorers.js";
import type { Rank } from "./rank.js";

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Registers a ranking eval across variants — never fails CI. @public */
export function explore<World, Output = unknown>(
  name: string,
  spec: {
    of: Agent<World, Output>;
    variants: Partial<Profile>[];
    scorers: Scorer<World, Output>[];
    given: Example<World>[];
    runs?: number | { count: number; minimumPassRate: number };
    rankBy?: Rank;
  },
): void {
  void name;
  void spec;
  notImplemented("explore");
}
