// Harness — scenario(). One behaviour, many worlds, shared scorers. Drives
// with runFlow (not the graph/ stepping primitives — evals never pause
// mid-flow), N times per row, folds each into a Run, scores, gates.
//
// Stub only — see the epic's Story 14 architecture note for the concrete
// behaviour this earns.

import type { Message } from "../../../index.js";
import type { Subject } from "../subject.js";
import type { Example, Fixtures } from "../fixtures.js";
import type { Scorer } from "../scorers.js";
import type { RegressionPolicy } from "../regression.js";

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Registers a gating eval: passes when every scorer clears its bar on enough runs of every row. @public */
export function scenario<World, Output = unknown>(
  name: string,
  spec: {
    of: Subject<World, Output>;
    scorers: Scorer<World, Output>[];
    given?: Example<World>[];
    world?: () => World;
    fixtures?: (world: World) => Fixtures;
    input?: Message;
    runs?: number | { count: number; minimumPassRate: number };
    regression?: RegressionPolicy;
  },
): void {
  void name;
  void spec;
  notImplemented("scenario");
}
