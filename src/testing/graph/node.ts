// Graph-test single-node assertion — nodeCalled. Pure — reads Run.visits, no
// engine. Mirrors the toolCalled scorer's shape one level up.
//
// Stub only — see the epic's Story 7 architecture note for the concrete
// behaviour this earns.

import type { Handle } from "../../index.js";
import type { Run } from "./run.js";

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Was `node` visited — how many times, with what input/output. @public */
export function nodeCalled<World, Output = unknown>(
  run: Run<World, Output>,
  node: Handle,
  opts?: {
    times?: number;
    input?: (input: unknown[]) => boolean;
    output?: (output: unknown) => boolean;
  },
): void {
  void run;
  void node;
  void opts;
  notImplemented("nodeCalled");
}
