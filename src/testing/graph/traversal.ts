// Graph-test traversal assertions — matchesTraversal (exact) and
// containsTraversal (subsequence), built from a small tree DSL: sequence,
// group, loop, branch. Pure — reads Run.traversal, no engine.
//
// Stub only — see the epic's Story 4/5 architecture notes for the concrete
// behaviour each earns.

import type { Handle, NodeId } from "../../index.js";
import type { Run } from "./run.js";

/** A node reference — either a real `Handle` (from `flow.step(...)`) or a bare `NodeId`, so pure unit tests can build a spec without a real graph. @public */
export type NodeRef = Handle | NodeId;

/** One node of a traversal-tree spec. @public */
export type Traverse =
  | { kind: "node"; node: NodeId }
  | { kind: "sequence"; items: Traverse[] }
  | { kind: "group"; branches: Traverse[] }
  | { kind: "loop"; node: NodeId; times?: number; min?: number }
  | { kind: "branch"; node: NodeId };

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Nodes must appear in this exact order. @public */
export function sequence(...items: (NodeRef | Traverse)[]): Traverse {
  void items;
  return notImplemented("sequence");
}

/** Nodes run in parallel — order between them is free. @public */
export function group(...branches: (NodeRef | Traverse)[]): Traverse {
  void branches;
  return notImplemented("group");
}

/** A node that ran one or more times (or an exact/minimum count). @public */
export function loop(node: NodeRef, opts?: { times?: number; min?: number }): Traverse {
  void node;
  void opts;
  return notImplemented("loop");
}

/** Exactly one of the routed nodes must have fired. @public */
export function branch(node: NodeRef): Traverse {
  void node;
  return notImplemented("branch");
}

/** The whole traversal must equal `spec` exactly. Throws with a diff on mismatch. @public */
export function matchesTraversal<World, Output = unknown>(
  run: Run<World, Output>,
  spec: Traverse | NodeRef,
): void {
  void run;
  void spec;
  notImplemented("matchesTraversal");
}

/** `spec` must appear as an order-preserving subsequence somewhere in the run. @public */
export function containsTraversal<World, Output = unknown>(
  run: Run<World, Output>,
  spec: Traverse | NodeRef,
): void {
  void run;
  void spec;
  notImplemented("containsTraversal");
}
