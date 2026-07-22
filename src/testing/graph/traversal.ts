// Graph-test traversal assertions — matchesTraversal (exact) and
// containsTraversal (subsequence), built from a small tree DSL: sequence,
// group, loop, branch. Pure — reads Run.traversal, no engine.
//
// Both matchers share one tree-walk (matchTree) and differ only in how a bare
// node is located (locateExact vs locateSubseq).

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

// Resolves a NodeRef to its underlying NodeId. Exported for node.ts to share
// — not part of the graph/ barrel, same as NodeRef itself.
export function nodeIdOf(ref: NodeRef): NodeId {
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

// Tries each unused branch as the next one, recursing into the rest on
// success and backtracking on failure — depth-first with pruning, not
// permutations(branches) generated up front. matchTree's own node/sequence
// cases already throw immediately on a mismatch, so a wrong branch choice
// fails fast instead of paying for the full remaining subtree; only a
// genuinely ambiguous spec (several branches that could each match next)
// pays for backtracking, and the true worst case remains exponential in
// branch count — same as any general group-matching problem.
function matchGroup(
  entries: Entry[],
  offset: number,
  branches: Traverse[],
  locate: Locate,
): number {
  if (branches.length === 0) return offset;
  let lastError: unknown;
  for (let i = 0; i < branches.length; i++) {
    const branch = branches.at(i);
    if (branch === undefined) continue;
    const rest = [...branches.slice(0, i), ...branches.slice(i + 1)];
    try {
      const pos = matchTree(entries, offset, branch, locate);
      return matchGroup(entries, pos, rest, locate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`group did not match at position ${String(offset)}`);
}

function describeGot(entries: Entry[], offset: number): string {
  return entries[offset] ? String(entries[offset].node) : "end of traversal";
}

/** Where a `node`/`branch`/`loop` spec's node is found from `offset` — the one thing exact vs subsequence matching disagree on. Throws with a message naming the expected node on failure. */
type Locate = (entries: Entry[], offset: number, node: NodeId) => number;

/** Exact matching: the node must sit right at `offset` — no gaps allowed. */
function locateExact(entries: Entry[], offset: number, node: NodeId): number {
  const got = entries[offset];
  if (!got?.node || got.node !== node) {
    throw new Error(
      `expected ${node} at position ${String(offset)}, got ${describeGot(entries, offset)}`,
    );
  }
  return offset;
}

/** Subsequence matching: the node may appear anywhere at or after `offset` — gaps allowed. */
function locateSubseq(entries: Entry[], offset: number, node: NodeId): number {
  const found = findNode(entries, offset, node);
  if (found === -1) {
    throw new Error(`expected ${node} somewhere at or after position ${String(offset)}, not found`);
  }
  return found;
}

function findNode(entries: Entry[], from: number, node: NodeId): number {
  for (let i = from; i < entries.length; i++) {
    if (entries[i]?.node === node) return i;
  }
  return -1;
}

/** Walks `spec` against `entries` from `offset`, using `locate` to decide where a bare node/loop-start may sit — adjacency-only for exact matching, anywhere-onward for subsequence matching. Returns the position just past the match. Shared by matchesTraversal and containsTraversal; only `locate` differs between them. */
function matchTree(entries: Entry[], offset: number, spec: Traverse, locate: Locate): number {
  switch (spec.kind) {
    case "node":
    case "branch":
      return locate(entries, offset, spec.node) + 1;
    case "sequence": {
      let pos = offset;
      for (const item of spec.items) {
        pos = matchTree(entries, pos, item, locate);
      }
      return pos;
    }
    case "loop": {
      // times: 0 means "never happens here" — nothing to locate (locate always
      // throws on absence), so check the adjacent run directly instead.
      if (spec.times === 0) {
        let adjacent = 0;
        while (entries[offset + adjacent]?.node === spec.node) adjacent++;
        if (adjacent !== 0) {
          throw new Error(`expected loop of ${spec.node} exactly 0 times, got ${String(adjacent)}`);
        }
        return offset;
      }
      const start = locate(entries, offset, spec.node);
      let count = 0;
      while (entries[start + count]?.node === spec.node) count++;
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
      return start + count;
    }
    case "group":
      return matchGroup(entries, offset, spec.branches, locate);
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
  const end = matchTree(entries, 0, normalizeSpec(spec), locateExact);
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
  const entries = run.traversal as Entry[];
  matchTree(entries, 0, normalizeSpec(spec), locateSubseq);
}
