// Graph-test single-node assertion — nodeCalled. Pure — reads Run.visits, no
// engine. Mirrors the toolCalled scorer's shape one level up.

import type { NodeRef } from "./traversal.js";
import type { NodeId } from "../../index.js";
import type { Run } from "./run.js";

function nodeIdOf(ref: NodeRef): NodeId {
  return typeof ref === "string" ? ref : ref.id;
}

/** Was `node` visited — how many times, with what input/output. @public */
export function nodeCalled<World, Output = unknown>(
  run: Run<World, Output>,
  node: NodeRef,
  opts?: {
    times?: number;
    input?: (input: unknown[]) => boolean;
    output?: (output: unknown) => boolean;
  },
): void {
  const nodeId = nodeIdOf(node);
  const matches = run.visits.filter((v) => v.node === nodeId);

  if (opts?.times !== undefined) {
    if (matches.length !== opts.times) {
      throw new Error(
        `expected ${nodeId} to be visited exactly ${String(opts.times)} times, got ${String(matches.length)}`,
      );
    }
  } else if (matches.length === 0) {
    throw new Error(`expected ${nodeId} to have been visited, but it was not`);
  }

  if (matches.length > 0 && opts?.input) {
    const inputPred = opts.input;
    const ok = matches.some((v) => inputPred(v.input));
    if (!ok) throw new Error(`expected some visit of ${nodeId} to satisfy the input predicate`);
  }

  if (matches.length > 0 && opts?.output) {
    const outputPred = opts.output;
    const ok = matches.some((v) => outputPred(v.output));
    if (!ok) throw new Error(`expected some visit of ${nodeId} to satisfy the output predicate`);
  }
}
