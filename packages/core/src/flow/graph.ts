// Flow authoring — defineGraph. See docs/reference.md § "defineGraph".

import type { Step } from "./step.js";
import type { Message } from "./message.js";
import type { Waitable } from "./waitable.js";
import type { ThreadAction } from "./thread.js";

/** Opaque brand for node identifiers within a graph. @public */
export type NodeId = string & { readonly __brand: "NodeId" };

/** Options attached to an edge — optional thread action, prompt transform, and a human-readable label (used by `graphToMermaid`; purely descriptive, never read by the engine). @public */
export interface EdgeOptions {
  threadAction?: ThreadAction; // omitted = "same"
  prompt?: (output: unknown) => Message;
  label?: string; // e.g. "no tools used" — shown instead of the generic when/otherwise/then name
}

/** Options shared by every node factory. `label` is a debug name for this node (a trace or log line). `state` is an application-level phase this node represents — several nodes may share one `state`; the engine emits a `stateChange` event only when it differs from the last one seen on the thread. @public */
export interface NodeOptions {
  label?: string;
  state?: string;
}

/** One node's declaration, as captured by the `Flow` builder. `label` and `state` are shared by every kind, not just `step`. */
export type NodeKind = { label?: string; state?: string } & (
  | { kind: "step"; run: Step }
  | { kind: "use"; subgraph: Graph }
  | { kind: "waitFor"; waitable: Waitable<unknown> }
  | { kind: "interrupt"; waitable: Waitable<unknown>; run: Step }
  | {
      kind: "forEach";
      items: (output: unknown) => readonly unknown[];
      branch: (item: unknown) => Graph;
    }
  | { kind: "finish" }
);

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
  /** This graph's declared abort target, if any (see `Flow.onAbort`). Absent means an
   * abort while something inside this graph is running has nowhere local to route —
   * the engine looks to the nearest enclosing `use()`-embedding graph's own `onAbort`
   * next, falling all the way back to today's behavior (fail the run) if nobody in
   * the chain declared one. @public */
  readonly onAbort?: NodeId;
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
  step<Result>(run: Step<Result>, options?: NodeOptions): Handle;
  use(subgraph: Graph, options?: NodeOptions): Handle; // compose a graph as a node; runs on the reaching edge's thread
  waitFor<T>(waitable: Waitable<T>, options?: NodeOptions): Handle; // park until `waitable`'s condition is met
  interrupt<T>(waitable: Waitable<T>, run: Step, options?: NodeOptions): Handle; // always armed
  forEach<Item>(
    items: (output: unknown) => readonly Item[],
    branch: (item: Item) => Graph,
    options?: NodeOptions,
  ): Handle; // dynamic, runtime-sized fan-out
  entry(node: Handle): void;
  /** Declares where this graph goes if something inside it is aborted (a user message
   * with `intent: "abort"` preempting an in-flight `context.modelCall`). Optional —
   * a graph that never calls this keeps today's behavior (an abort fails the whole
   * run). Not per-node: what abort means is a property of the graph as a whole, the
   * same way `entry` is. @public */
  onAbort(target: Handle): void;
  readonly finish: Handle; // route a value in to end the flow; that value is the result
}

// Node ids are deterministic across separate builds of the same graph shape,
// AND unique across every nesting level within one composed graph tree. Both
// properties matter, to different consumers:
//
// - Determinism: a durable store outlives any one process, and node ids are
//   what the log records. Calling the exact same graph-building function
//   twice — once at session creation, again when a later process restarts and
//   reattaches to the same store — must assign identical ids to structurally
//   identical nodes, or every logged id is foreign garbage to the process
//   replaying it (see tests/acceptance/node-id-determinism.test.ts). So the
//   counter resets to 0 at the start of every OUTERMOST `defineGraph()` call.
//
// - Uniqueness within one tree: engine/runtime/tick.ts's `replayPosition`
//   decides which nesting level owns a logged node id by testing id
//   membership across every level of the current descent path — which only
//   works if an outer flow and a `use()`d subgraph never hand out the same
//   id. A `defineGraph()` call that happens while another one is already in
//   progress on the call stack (e.g. `agentTurn(profile)` invoked
//   synchronously from inside a builder callback, `flow.use(agentTurn(p))`)
//   therefore does NOT reset — it keeps drawing from wherever the enclosing
//   build's counter already is, so nested subgraph ids never collide with
//   the enclosing graph's own. Graph-building is entirely synchronous (no
//   `await` in a `Flow` builder callback), so a plain reentrant call-depth
//   counter is sufficient — resets happen only on the 0→1 transition.
//
// A PRE-BUILT subgraph passed to `flow.use()` (built by its own earlier
// outermost call, so its ids restarted from 0 too) would break the second
// property — its ids would overlap the embedding graph's. `reserve()` closes
// that hole: `Flow.use` advances the counter past every id the subgraph tree
// already holds before allocating the `use` node's own id, so everything the
// embedding build allocates from that point on (the `use` node id in
// particular — the id `replayPosition` must recognize as the subgraph's own
// completion) stays disjoint from the subgraph's. A subgraph built inline
// during the current build already drew from the running counter, so
// `reserve` is a no-op for it — no need to distinguish the two cases.
//
// `forEach` branch graphs (built at runtime by `node.branch(item)`, i.e. as
// their own outermost calls) DO share ids with the main graph under this
// scheme — deliberately tolerated: branch progress is recognized by each
// branch's deterministic thread id, never by node id (see
// engine/runtime/foreach.ts's own doc comment), and `replayPosition` excludes
// branch-thread events from its id-membership search for the same reason
// (see tick.ts's forEach handling in the replay loop).
const nodeIdSequence = (() => {
  let next = 0;
  let buildDepth = 0;
  return {
    fresh(): NodeId {
      next += 1;
      return `node-${String(next)}` as NodeId;
    },
    /** Advances the counter past every id `graph` — or any subgraph reachable through its `use` nodes — already holds, so ids allocated afterwards never collide with it. Deterministic as long as the reserved graph itself was deterministically built. */
    reserve(graph: Graph): void {
      next = Math.max(next, maxNumericNodeId(graph, new Set()));
    },
    enterBuild(): void {
      buildDepth += 1;
      if (buildDepth === 1) next = 0;
    },
    exitBuild(): void {
      buildDepth -= 1;
    },
  };
})();
function freshNodeId(): NodeId {
  return nodeIdSequence.fresh();
}

/** The largest numeric suffix any node id carries anywhere in `graph`'s tree — its own nodes plus every `use` node's subgraph, recursively (`seen` guards against a graph reachable twice). Non-`node-N` ids (none exist today) are ignored rather than crashed on. */
function maxNumericNodeId(graph: Graph, seen: Set<Graph>): number {
  if (seen.has(graph)) return 0;
  seen.add(graph);
  let max = 0;
  for (const [id, node] of graph.nodes) {
    const match = /^node-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
    if (node.kind === "use") max = Math.max(max, maxNumericNodeId(node.subgraph, seen));
  }
  return max;
}

/** Picks `label`/`state` out of a node factory's options, omitting either key entirely when absent rather than writing `undefined` — shared by every factory in `Flow` so each writes its own kind-specific fields plus this one call, and by `findInterruptNodes` (engine/runtime/drive.ts), which needs the same two-field projection off an already-built `InterruptNode`. @public */
export function nodeOptionFields(options?: NodeOptions): { label?: string; state?: string } {
  return {
    ...(options?.label ? { label: options.label } : {}),
    ...(options?.state ? { state: options.state } : {}),
  };
}

/** Defines a named, runnable flow graph from a declarative build callback. @public */
export function defineGraph(name: string, build: (flow: Flow) => void): Graph {
  // Depth-aware id determinism: only the outermost call resets the node id
  // counter; a nested call (a subgraph built inline from within a builder
  // callback) keeps drawing from the running count — see `nodeIdSequence`'s
  // own doc comment. try/finally so a throwing build (e.g. "has no entry
  // node") can't leave the depth counter permanently off.
  nodeIdSequence.enterBuild();
  try {
    return buildGraph(name, build);
  } finally {
    nodeIdSequence.exitBuild();
  }
}

function buildGraph(name: string, build: (flow: Flow) => void): Graph {
  const nodes = new Map<NodeId, NodeKind>();
  const edges: EdgeDefinition[] = [];
  let entry: NodeId | undefined;
  let onAbort: NodeId | undefined;

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
        ...nodeOptionFields(options),
      });
      return makeHandle(id);
    },
    use(subgraph, options) {
      // A pre-built subgraph (its own earlier outermost build, ids restarted
      // from 0) would otherwise overlap this build's ids — advance past its
      // whole tree first, so this `use` node's own id (the id `replayPosition`
      // recognizes as the subgraph's completion) can never be claimed by a
      // node inside it. No-op for a subgraph built inline during this build.
      nodeIdSequence.reserve(subgraph);
      const id = freshNodeId();
      nodes.set(id, { kind: "use", subgraph, ...nodeOptionFields(options) });
      return makeHandle(id);
    },
    waitFor(waitable, options) {
      const id = freshNodeId();
      nodes.set(id, { kind: "waitFor", waitable, ...nodeOptionFields(options) });
      return makeHandle(id);
    },
    interrupt(waitable, run, options) {
      const id = freshNodeId();
      nodes.set(id, { kind: "interrupt", waitable, run, ...nodeOptionFields(options) });
      return makeHandle(id);
    },
    forEach(items, branch, options) {
      const id = freshNodeId();
      nodes.set(id, {
        kind: "forEach",
        items,
        branch: branch as (item: unknown) => Graph,
        ...nodeOptionFields(options),
      });
      return makeHandle(id);
    },
    entry(node) {
      entry = node.id;
    },
    onAbort(target) {
      onAbort = target.id;
    },
    finish: finishHandle,
  };

  build(flow);

  if (!entry) throw new Error(`graph "${name}" has no entry node — call flow.entry(...)`);

  return { name, nodes, edges, entry, ...(onAbort ? { onAbort } : {}) };
}
