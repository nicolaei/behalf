// Flow authoring — defineGraph. See docs/reference.md § "defineGraph".

import type { Step } from "./step.js";
import type { Message, MessageKind } from "./message.js";
import type { ThreadAction } from "./thread.js";

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
  | { kind: "waitFor"; messageKind: MessageKind }
  | { kind: "interrupt"; messageKind: MessageKind; run: Step }
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
  waitFor(kind: MessageKind): Handle; // park until a matching message is in the inbox
  interrupt(kind: MessageKind, run: Step): Handle; // always armed
  entry(node: Handle): void;
  readonly finish: Handle; // route a value in to end the flow; that value is the result
}

let nextNodeId = 0;
function freshNodeId(): NodeId {
  nextNodeId += 1;
  return `node-${String(nextNodeId)}` as NodeId;
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
    waitFor(kind) {
      const id = freshNodeId();
      nodes.set(id, { kind: "waitFor", messageKind: kind });
      return makeHandle(id);
    },
    interrupt(kind, run) {
      const id = freshNodeId();
      nodes.set(id, { kind: "interrupt", messageKind: kind, run });
      return makeHandle(id);
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
