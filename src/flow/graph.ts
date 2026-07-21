// Flow authoring — defineGraph. See docs/reference.md § "defineGraph".

import type { Step } from "./step.js";
import type { Message } from "./message.js";
import type { Waitable } from "./waitable.js";
import type { ThreadAction } from "./thread.js";
import { notImplemented } from "../engine/errors.js";

/** Opaque brand for node identifiers within a graph. @public */
export type NodeId = string & { readonly __brand: "NodeId" };

/** Options attached to an edge — optional thread action and prompt transform. @public */
export interface EdgeOptions {
  threadAction?: ThreadAction; // omitted = "same"
  prompt?: (output: unknown) => Message;
}

/** One node's declaration, as captured by the `Flow` builder. */
export type NodeKind =
  | { kind: "step"; run: Step; label?: string }
  | { kind: "use"; subgraph: Graph }
  | { kind: "waitFor"; waitable: Waitable<unknown> }
  | { kind: "interrupt"; waitable: Waitable<unknown>; run: Step }
  | {
      kind: "forEach";
      items: (output: unknown) => readonly unknown[];
      branch: (item: unknown) => Graph;
    }
  | { kind: "finish" };

/** One edge's declaration, as captured by `Handle.when`/`.otherwise`/`.then`. */
export interface EdgeDefinition {
  from: NodeId;
  to: NodeId;
  edge: "when" | "otherwise" | "then";
  condition?: (output: unknown) => boolean;
  options?: EdgeOptions;
}

/** A composed, runnable flow — the nodes and edges the `Flow` builder captured. @public */
export interface Graph {
  readonly name: string;
  readonly nodes: ReadonlyMap<NodeId, NodeKind>;
  readonly edges: readonly EdgeDefinition[];
  readonly entry: NodeId;
}

/** Fluent builder handle returned by every `Flow` node factory. @public */
export interface Handle {
  readonly id: NodeId;
  when(condition: (output: unknown) => boolean, to: Handle, options?: EdgeOptions): Handle;
  otherwise(to: Handle, options?: EdgeOptions): Handle;
  then(to: Handle | Handle[], options?: EdgeOptions): void; // single next node, or fan-out to multiple threads
}

/** The DSL object passed to `defineGraph`’s build callback. @public */
export interface Flow {
  step<Result>(run: Step<Result>, options?: { label?: string }): Handle;
  use(subgraph: Graph): Handle; // compose a graph as a node; runs on the reaching edge's thread
  waitFor<T>(waitable: Waitable<T>): Handle; // park until `waitable`'s condition is met
  interrupt<T>(waitable: Waitable<T>, run: Step): Handle; // always armed
  forEach<Item>(items: (output: unknown) => readonly Item[], branch: (item: Item) => Graph): Handle; // dynamic, runtime-sized fan-out
  entry(node: Handle): void;
  readonly finish: Handle; // route a value in to end the flow; that value is the result
}

// Node ids stay unique across every graph in the process — not just within
// one `defineGraph()` call — so this counter is NOT reset or re-scoped per
// call, unlike runtime.ts's per-Runtime idFactory (see runtime.ts's
// freshCorrelationId/freshThreadId). engine/runtime.ts's `replayPosition`
// decides which frame owns a logged node id by testing id membership across
// every frame's own graph — an invariant (see its own docstring) that only
// holds if two independently defined graphs — commonly an outer flow and a
// `use()`d subgraph, each built by its own separate `defineGraph()` call —
// never hand out the same id. Scoping the counter per `defineGraph()`
// call, as runtime.ts's ids are now scoped per `Runtime`, would silently
// break that invariant instead of just changing the id format — a real
// behavior change, not a pure restructuring, so it's out of scope here.
//
// What *is* in scope: not leaving the counter as a bare, directly-mutable
// module `let` — encapsulated behind `fresh()` instead, so every increment
// goes through one defined operation.
const nodeIdSequence = (() => {
  let next = 0;
  return {
    fresh(): NodeId {
      next += 1;
      return `node-${String(next)}` as NodeId;
    },
  };
})();
function freshNodeId(): NodeId {
  return nodeIdSequence.fresh();
}

/** Defines a named, runnable flow graph from a declarative build callback. @public */
export function defineGraph(name: string, build: (flow: Flow) => void): Graph {
  const nodes = new Map<NodeId, NodeKind>();
  const edges: EdgeDefinition[] = [];
  let entry: NodeId | undefined;

  function makeHandle(id: NodeId): Handle {
    const handle = {
      id,
      when(condition, to, options) {
        edges.push({
          from: id,
          to: to.id,
          edge: "when",
          condition,
          ...(options ? { options } : {}),
        });
        return handle;
      },
      otherwise(to, options) {
        edges.push({ from: id, to: to.id, edge: "otherwise", ...(options ? { options } : {}) });
        return handle;
      },
      then(to: Handle | Handle[], options?: EdgeOptions): void {
        if (Array.isArray(to)) {
          for (const target of to) {
            edges.push({ from: id, to: target.id, edge: "then", ...(options ? { options } : {}) });
          }
          return;
        }
        edges.push({ from: id, to: to.id, edge: "then", ...(options ? { options } : {}) });
      },
    } as Handle;
    return handle;
  }

  const finishId = freshNodeId();
  nodes.set(finishId, { kind: "finish" });
  const finishHandle = makeHandle(finishId);

  const flow: Flow = {
    step(run, options) {
      const id = freshNodeId();
      nodes.set(id, {
        kind: "step",
        run,
        ...(options?.label ? { label: options.label } : {}),
      });
      return makeHandle(id);
    },
    use(subgraph) {
      const id = freshNodeId();
      nodes.set(id, { kind: "use", subgraph });
      return makeHandle(id);
    },
    waitFor(waitable) {
      const id = freshNodeId();
      nodes.set(id, { kind: "waitFor", waitable });
      return makeHandle(id);
    },
    interrupt(waitable, run) {
      const id = freshNodeId();
      nodes.set(id, { kind: "interrupt", waitable, run });
      return makeHandle(id);
    },
    forEach() {
      return notImplemented("Flow.forEach");
    },
    entry(node) {
      entry = node.id;
    },
    finish: finishHandle,
  };

  build(flow);

  if (!entry) throw new Error(`graph "${name}" has no entry node — call flow.entry(...)`);

  return { name, nodes, edges, entry };
}
