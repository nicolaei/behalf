// Graph-test traversal assertions — matchesTraversal (exact) and
// containsTraversal (subsequence), built from a small tree DSL: sequence,
// group, loop, branch. Pure — reads Run.traversal, no engine.
//
// containsTraversal is a stub — see the epic's Story 5 architecture note for
// the concrete behaviour it earns.

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

function nodeIdOf(ref: NodeRef): NodeId {
  return typeof ref === "string" ? ref : ref.id;
}

function isTraverse(item: NodeRef | Traverse): item is Traverse {
  return typeof item === "object" && "kind" in item;
}

function toTraverse(item: NodeRef | Traverse): Traverse {
  return isTraverse(item) ? item : { kind: "node", node: nodeIdOf(item) };
}

/** Nodes must appear in this exact order. @public */
export function sequence(...items: (NodeRef | Traverse)[]): Traverse {
  return { kind: "sequence", items: items.map(toTraverse) };
}

/** Nodes run in parallel — order between them is free. @public */
export function group(...branches: (NodeRef | Traverse)[]): Traverse {
  return { kind: "group", branches: branches.map(toTraverse) };
}

/** A node that ran one or more times (or an exact/minimum count). @public */
export function loop(node: NodeRef, opts?: { times?: number; min?: number }): Traverse {
  const nodeId = nodeIdOf(node);
  if (opts?.times !== undefined) return { kind: "loop", node: nodeId, times: opts.times };
  if (opts?.min !== undefined) return { kind: "loop", node: nodeId, min: opts.min };
  return { kind: "loop", node: nodeId };
}

/** Exactly one of the routed nodes must have fired. @public */
export function branch(node: NodeRef): Traverse {
  return { kind: "branch", node: nodeIdOf(node) };
}

interface Entry {
  node: NodeId;
  name?: string;
  thread: unknown;
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const head = arr[i] as T;
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([head, ...perm]);
    }
  }
  return result;
}

function describeGot(entries: Entry[], offset: number): string {
  return entries[offset] ? String(entries[offset].node) : "end of traversal";
}

function matchOne(entries: Entry[], offset: number, spec: Traverse): number {
  switch (spec.kind) {
    case "node":
    case "branch": {
      const got = entries[offset];
      if (!got?.node || got.node !== spec.node) {
        throw new Error(
          `expected ${spec.node} at position ${String(offset)}, got ${describeGot(entries, offset)}`,
        );
      }
      return offset + 1;
    }
    case "sequence": {
      let pos = offset;
      for (const item of spec.items) {
        pos = matchOne(entries, pos, item);
      }
      return pos;
    }
    case "loop": {
      let count = 0;
      while (entries[offset + count]?.node === spec.node) count++;
      if (count === 0) {
        throw new Error(
          `expected loop of ${spec.node} at position ${String(offset)}, got ${describeGot(entries, offset)}`,
        );
      }
      if (spec.times !== undefined && count !== spec.times) {
        throw new Error(
          `expected loop of ${spec.node} exactly ${String(spec.times)} times, got ${String(count)}`,
        );
      }
      if (spec.min !== undefined && count < spec.min) {
        throw new Error(
          `expected loop of ${spec.node} at least ${String(spec.min)} times, got ${String(count)}`,
        );
      }
      return offset + count;
    }
    case "group": {
      let lastError: unknown;
      for (const perm of permutations(spec.branches)) {
        try {
          let pos = offset;
          for (const branchSpec of perm) {
            pos = matchOne(entries, pos, branchSpec);
          }
          return pos;
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError instanceof Error) throw lastError;
      throw new Error(`group did not match at position ${String(offset)}`);
    }
  }
}

function normalizeSpec(spec: Traverse | NodeRef): Traverse {
  return isTraverse(spec) ? spec : { kind: "node", node: nodeIdOf(spec) };
}

/** The whole traversal must equal `spec` exactly. Throws with a diff on mismatch. @public */
export function matchesTraversal<World, Output = unknown>(
  run: Run<World, Output>,
  spec: Traverse | NodeRef,
): void {
  const entries = run.traversal as Entry[];
  const normalized = normalizeSpec(spec);
  const end = matchOne(entries, 0, normalized);
  if (end !== entries.length) {
    throw new Error(
      `expected traversal to end at position ${String(end)}, but ${String(entries.length - end)} more entries followed (next: ${describeGot(entries, end)})`,
    );
  }
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
