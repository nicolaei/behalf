// Flow authoring — defineGraph. See docs/reference.md § "defineGraph".

import type { Step } from "./step.js";
import type { Message, MessageKind } from "./message.js";
import type { ThreadAction } from "./thread.js";

export type NodeId = string & { readonly __brand: "NodeId" };

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
  edge: "when" | "otherwise" | "then" | "join";
  condition?: (output: unknown) => boolean;
  options?: EdgeOptions;
}

/** A composed, runnable flow — the nodes and edges the `Flow` builder captured. */
export interface Graph {
  readonly name: string;
  readonly nodes: ReadonlyMap<NodeId, NodeKind>;
  readonly edges: readonly EdgeDefinition[];
  readonly entry: NodeId;
}

export interface Handle {
  readonly id: NodeId;
  when(condition: (output: unknown) => boolean, to: Handle, options?: EdgeOptions): Handle;
  otherwise(to: Handle, options?: EdgeOptions): Handle;
  then(to: Handle, options?: EdgeOptions): void; // continue to one node
  then(to: Handle[], options?: EdgeOptions): Group; // fan out — each on its own thread
}

export interface Group {
  join(to: Handle, options?: EdgeOptions): void; // run `to` once when every branch finishes
}

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

export function defineGraph(name: string, build: (flow: Flow) => void): Graph {
  const nodes = new Map<NodeId, NodeKind>();
  const edges: EdgeDefinition[] = [];
  let entry: NodeId | undefined;

  function makeHandle(id: NodeId): Handle {
    return {
      id,
      when(condition, to, options) {
        edges.push({
          from: id,
          to: to.id,
          edge: "when",
          condition,
          ...(options ? { options } : {}),
        });
        return to;
      },
      otherwise(to, options) {
        edges.push({ from: id, to: to.id, edge: "otherwise", ...(options ? { options } : {}) });
        return to;
      },
      then(to: Handle | Handle[], options?: EdgeOptions): Group | undefined {
        if (Array.isArray(to)) {
          for (const target of to) {
            edges.push({ from: id, to: target.id, edge: "then", ...(options ? { options } : {}) });
          }
          return {
            join(joinTarget, joinOptions) {
              for (const target of to) {
                edges.push({
                  from: target.id,
                  to: joinTarget.id,
                  edge: "join",
                  ...(joinOptions ? { options: joinOptions } : {}),
                });
              }
            },
          };
        }
        edges.push({ from: id, to: to.id, edge: "then", ...(options ? { options } : {}) });
        return undefined;
      },
    } as Handle;
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
