// Tick and replay: reconstructs where a flow last left off purely from the
// event log, advances it exactly one node, and the `tickUntilSuspended`
// helper that repeats until every cursor is parked or done.

import type { Graph, NodeId } from "../../flow/graph.js";
import type { Message, MessageKind } from "../../flow/message.js";
import type { StepContext, WaitForResult } from "../../flow/step.js";
import type { Event } from "../../session/event.js";
import type { Runtime } from "../runtime.js";
import { freshThreadId } from "./ids.js";
import { notImplemented, unreachable } from "../errors.js";
import {
  type Thread,
  stepIdentity,
  appendOutput,
  route,
  commitRoute,
  withMessage,
  thenEdges,
} from "./routing.js";
import { runStep, assertJoinTagging, withInputs } from "./step-runner.js";
import {
  type FanOutGroup,
  buildFanOutGroup,
  foldGroup,
  replayBranchOutput,
  advanceFanOutGroup,
  branchCursorState,
} from "./fan-out.js";
import {
  type InterruptNode,
  buildDriveContext,
  driveStepEmit,
  driveWaitForMessage,
  fanOutTargets,
  findInterruptNodes,
  seedUseNode,
} from "./drive.js";

/** One cursor's current state within a tick() outcome — node, status, and (for parked) what it's waiting for. */
export interface CursorState {
  node: NodeId;
  status: "active" | "parked" | "done";
  waitingFor?: MessageKind[]; // present only when status is "parked"
  result?: unknown; // present only when status is "done" (root cursor only)
  parent?: string; // absent = this is the root cursor; present = identifies which cursor this folds into
}

/** One tick()'s outcome: a set of independently-progressing cursors. For single-cursor flows, always a one-element array. */
export type TickOutcome = CursorState[];

/** One level of a replayed `tick()` position — the outermost flow, or a `use` node's subgraph descended into it. Unlike the old frame stack, nothing here identifies which node led into this frame: that lives on the enclosing `CursorTree`'s own `use-descent` node instead (see below), since it's the only thing that ever needs it. */
interface ReplayFrame {
  flow: Graph;
  current: NodeId;
  currentInput: unknown;
  // The edge-resolved prompt (if any) that led to `current` — what a `use`
  // node reached next would seed its subgraph with. Mirrors driveGraph's
  // own `reason` variable, reconstructed the same way from replay.
  reason?: Message | undefined;
}

/**
 * A tick() position, as a tree instead of a frame stack plus a fan-out
 * side-channel: `step` is ordinary mid-flight progress; `use-descent` is a
 * `use` node's subgraph, entered but not yet finished, wrapping whatever
 * position is current inside it; `fan-out` is an in-flight fan-out group,
 * replacing the position entirely (fan-out is only ever reconstructed at the
 * outermost level — see the `notImplemented` guards below and in `tick`'s own
 * live loop — so today it can only appear as the tree's root, never nested
 * under a `use-descent`, even though the type itself doesn't forbid that
 * combination). Parameterized over the frame shape so the same shape serves
 * both replay (`ReplayFrame`) and tick's live walk (`LiveFrame`).
 */
export type CursorTree<TFrame = ReplayFrame> =
  | { kind: "step"; frame: TFrame }
  | { kind: "use-descent"; outerNode: NodeId; inner: CursorTree<TFrame> }
  | { kind: "fan-out"; group: FanOutGroup };

/** One level of `cursorPath`'s walk down a `CursorTree`: the node at that level, and the flow it runs in (derived from the enclosing level's own `use` node, never stored on the tree itself). */
interface PathLevel<TFrame> {
  flow: Graph;
  node: CursorTree<TFrame>;
}

/**
 * Walks a `CursorTree` from its root down to its innermost node, deriving
 * each level's own flow along the way — level 0 is `rootFlow`; a
 * `use-descent`'s own level derives the next one from its `outerNode`'s own
 * `subgraph`, the same way a live `use` node's subgraph would be found. This
 * replaces indexing the old frame stack outermost-first: the returned path's
 * last entry is what `frames[frames.length - 1]` used to be.
 */
function cursorPath<TFrame extends { flow: Graph }>(
  rootFlow: Graph,
  tree: CursorTree<TFrame>,
): PathLevel<TFrame>[] {
  const path: PathLevel<TFrame>[] = [];
  let flow = rootFlow;
  let node: CursorTree<TFrame> = tree;
  for (;;) {
    path.push({ flow, node });
    if (node.kind !== "use-descent") return path;
    const useNode = flow.nodes.get(node.outerNode);
    if (useNode?.kind !== "use") unreachable("cursorPath: outerNode does not name a use node");
    flow = useNode.subgraph;
    node = node.inner;
  }
}

/**
 * Rebuilds a `CursorTree` with the node at `path[depth]` replaced by
 * `newLeaf`, rewrapping every ancestor above it unchanged — the tree
 * equivalent of truncating the old frame stack back to `depth` (a `use`
 * subgraph reaching its own finish, one or more levels at once) or, when
 * `depth` is the path's own last index, simply advancing the innermost
 * position in place.
 */
function rebuildFromPath<TFrame>(
  path: PathLevel<TFrame>[],
  depth: number,
  newLeaf: CursorTree<TFrame>,
): CursorTree<TFrame> {
  let result = newLeaf;
  for (let i = depth - 1; i >= 0; i -= 1) {
    const ancestor = path[i]?.node;
    if (ancestor?.kind !== "use-descent")
      unreachable("rebuildFromPath: ancestor is not a use-descent");
    result = { kind: "use-descent", outerNode: ancestor.outerNode, inner: result };
  }
  return result;
}

/** Where a fresh replay of `runtime.store`'s committed events left off: the position tree plus the thread it shares throughout (a `use` node's subgraph never forks it) and any pending fan-out join inputs. */
interface ReplayPosition {
  thread: Thread;
  tree: CursorTree;
  // Set only when replay landed on a join node whose fan-out group just
  // folded (every branch reported) — one entry per branch, in declared
  // order, mirroring driveStepEmit's own `pendingInputs`. Fan-out is only
  // ever reconstructed at the outermost level — see `advanceFanOutGroup`.
  pendingInputs?: unknown[];
}

/** What a fresh replay of `runtime.store` left off at: mid-flight on one line (`single`), or spread across an in-flight fan-out group's branches (`fanout`). */
type ReplayResult = ({ kind: "single" } & ReplayPosition) | { kind: "fanout"; group: FanOutGroup };

/**
 * Reconstructs `tick`'s position purely from `runtime.store.events()` — no
 * state survives anywhere else. Starts at `flow.entry` with a fresh thread
 * when the log is empty, then replays every committed `output` (a step ran;
 * follow the edge its value selects, same as `advance`) and `message` (a
 * `waitFor` consumed one, or a `use` node's subgraph was seeded; follow *its*
 * edge, or descend into it, the same way) event in order, landing exactly
 * where the last tick call left off. A fan-out node's own output event
 * switches this into per-branch reconstruction (`FanOutGroup`) until either
 * every branch has reported (folding back to a single position at the join
 * node, `pendingInputs` set) or the join node's own output event shows the
 * fold already ran on an earlier tick call — the log-level signal to resume
 * ordinary single-line replay from there. Fan-out is only ever reconstructed
 * at the outermost level — a fan-out inside a used subgraph is
 * notImplemented, matching tick()'s own live handling.
 *
 * A `use` node's subgraph shares its parent's thread (never forked), so
 * thread identity says nothing about whether a given event belongs to the
 * outer flow or a nested descent — only the event's own node id does. Every
 * node across every graph gets a globally unique id (see flow/graph.ts's
 * `freshNodeId`), so an output event's `stepId` belongs to exactly one
 * level; `cursorPath` mirrors the `use` descents a live tick() call would
 * have made: a level is added the moment a `message` event seeds a `use`
 * node's subgraph, and levels below an enclosing owner are dropped the
 * moment an output event turns up whose id belongs to that enclosing level
 * instead — the completion event `commitOutput` tags with the `use` node's
 * own (outer) id once its subgraph reaches `finish`.
 */
function replayPosition(flow: Graph, runtime: Runtime): ReplayResult {
  let thread: Thread = { id: freshThreadId(runtime), messages: [], history: [] };
  let tree: CursorTree = {
    kind: "step",
    frame: { flow, current: flow.entry, currentInput: undefined },
  };

  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;

    if (tree.kind === "fan-out") {
      const group = tree.group;
      if (envelope.type === "output") {
        const { value } = envelope.event as Event["output"];
        const stepId = envelope.stepId as NodeId;
        if (stepId === group.joinNodeId) {
          // The join already ran on an earlier tick call: the group folded
          // in the log itself. Resume ordinary single-line replay from here.
          thread = group.mainThread;
          const routed = route(flow.edges, stepId, value, thread, runtime);
          thread = routed.thread;
          tree = {
            kind: "step",
            frame: { flow, current: routed.to, currentInput: routed.input, reason: routed.reason },
          };
        } else {
          replayBranchOutput(group, envelope.threadId, stepId, value, flow);
        }
      }
      // toolCall/toolResult/compaction/invalidation/error/message inside a
      // branch aren't produced by any node kind `runBranchNode` supports —
      // out of scope for this slice's replay, same as the single-line path.
      continue;
    }

    if (envelope.threadId) thread = { ...thread, id: envelope.threadId };

    if (envelope.type === "output") {
      const { value } = envelope.event as Event["output"];
      const stepId = envelope.stepId as NodeId;

      // Find the level that actually owns this node id, from the innermost
      // level outward. Node ids are globally unique per graph, so exactly
      // one level ever recognizes a given id; landing on an ENCLOSING
      // level's own id (rather than the innermost one's) means every level
      // above it already reached its own `finish` — each logged its own
      // such completion event first — so rebuilding the tree back to that
      // depth is simply catching up on pops a live tick() call already made.
      const path: PathLevel<ReplayFrame>[] = cursorPath(flow, tree);
      let depth = path.length - 1;
      for (; depth >= 0; depth -= 1) {
        if (path[depth]?.flow.nodes.has(stepId)) break;
      }
      if (depth < 0) continue; // inner noise no known level owns — skip
      const owner: PathLevel<ReplayFrame> | undefined = path[depth];
      if (!owner) unreachable("replayPosition: owner missing after depth search");
      const ownerFlow = owner.flow;

      const branchTargets = thenEdges(ownerFlow.edges, stepId).map((edge) => edge.to);
      if (branchTargets.length > 1) {
        if (depth > 0) notImplemented("tick: fan-out inside a used subgraph");
        // A fan-out node's own output: hand off to per-branch reconstruction
        // instead of `advance`, which would silently pick just the first
        // branch (see `selectEdge`) and desync from what actually ran.
        tree = {
          kind: "fan-out",
          group: buildFanOutGroup(branchTargets, stepId, ownerFlow, thread, value),
        };
        continue;
      }

      const routed = route(ownerFlow.edges, stepId, value, thread, runtime);
      thread = routed.thread;
      tree = rebuildFromPath(path, depth, {
        kind: "step",
        frame: {
          flow: ownerFlow,
          current: routed.to,
          currentInput: routed.input,
          reason: routed.reason,
        },
      });
      continue;
    }

    if (envelope.type === "message") {
      const { message } = envelope.event as Event["message"];
      const path = cursorPath(flow, tree);
      const top = path[path.length - 1];
      if (!top) unreachable("replayPosition: position path is empty");
      if (top.node.kind !== "step") unreachable("replayPosition: innermost position is not a step");
      const topFrame = top.node.frame;
      const node = top.flow.nodes.get(topFrame.current);

      if (node?.kind === "waitFor") {
        thread = withMessage(thread, message);
        const routed = route(top.flow.edges, topFrame.current, message, thread, runtime);
        thread = routed.thread;
        tree = rebuildFromPath(path, path.length - 1, {
          kind: "step",
          frame: {
            flow: top.flow,
            current: routed.to,
            currentInput: { ok: true } satisfies WaitForResult,
            reason: routed.reason,
          },
        });
        continue;
      }

      if (node?.kind === "use") {
        // Entering this use node's subgraph: mirrors driveUseNode's own seed
        // dedup (a "same"-threadAction reaching edge already pushed this
        // message onto the thread; this event just echoes it into the log)
        // and descends a level at the subgraph's own entry, seeded with this
        // exact message — the same value `driveGraph`'s own `input`
        // parameter would carry.
        if (!topFrame.reason) thread = withMessage(thread, message);
        tree = rebuildFromPath(path, path.length - 1, {
          kind: "use-descent",
          outerNode: topFrame.current,
          inner: {
            kind: "step",
            frame: { flow: node.subgraph, current: node.subgraph.entry, currentInput: message },
          },
        });
        continue;
      }

      // Belongs to a node this replay isn't tracking as any level's
      // `current` — safe to skip; it never needs to move a level's position.
      continue;
    }
    // toolCall/toolResult/compaction/invalidation/error don't move the main
    // position on their own — out of scope for this slice's replay.
  }

  if (tree.kind === "fan-out") {
    const folded = foldGroup(tree.group);
    if (folded) {
      return {
        kind: "single",
        thread: tree.group.mainThread,
        tree: { kind: "step", frame: { flow, current: folded.current, currentInput: undefined } },
        pendingInputs: folded.pendingInputs,
      };
    }
    return { kind: "fanout", group: tree.group };
  }

  return { kind: "single", thread, tree };
}

/** One level of tick()'s live execution — same shape as a `ReplayFrame`, plus what only matters while actually running: this level's own armed interrupts (recomputed per level, same as `driveGraph` does for every nested `driveGraph` call) and the `StepContext` its own nodes run with. */
interface LiveFrame {
  flow: Graph;
  interrupts: InterruptNode[];
  current: NodeId;
  currentInput: unknown;
  reason?: Message | undefined;
  context: StepContext;
}

/** Builds a `LiveFrame` from a replayed one, wiring its `StepContext` to read this exact level's own (mutable) `current` through a closure over a holder cell — shared by the level's own `current` accessor and `buildDriveContext`, so a later tree rebuild only ever swaps which `CursorTree` node holds this frame, never anything `buildDriveContext` captured, and the frame is built complete and correctly-typed in one step (no incomplete-object cast). */
function buildLiveFrame(
  replayFrame: ReplayFrame,
  runtime: Runtime,
  getThread: () => Thread,
  setThread: (thread: Thread) => void,
): LiveFrame {
  const holder = { current: replayFrame.current };
  return {
    flow: replayFrame.flow,
    interrupts: findInterruptNodes(replayFrame.flow),
    get current() {
      return holder.current;
    },
    set current(value: NodeId) {
      holder.current = value;
    },
    currentInput: replayFrame.currentInput,
    ...(replayFrame.reason !== undefined ? { reason: replayFrame.reason } : {}),
    context: buildDriveContext(
      replayFrame.flow,
      runtime,
      () => holder.current,
      getThread,
      setThread,
    ),
  };
}

/** Converts a replayed position tree into a live one, wiring each `step` leaf's `LiveFrame` and preserving every `use-descent` wrapper unchanged. A `fan-out` node can't appear here: `tick` already returns straight out of `advanceFanOutGroup` before ever building a live tree — see `tick`'s own `position.kind === "fanout"` branch. */
function toLiveTree(
  tree: CursorTree,
  runtime: Runtime,
  getThread: () => Thread,
  setThread: (thread: Thread) => void,
): CursorTree<LiveFrame> {
  if (tree.kind === "step")
    return { kind: "step", frame: buildLiveFrame(tree.frame, runtime, getThread, setThread) };
  if (tree.kind === "use-descent")
    return {
      kind: "use-descent",
      outerNode: tree.outerNode,
      inner: toLiveTree(tree.inner, runtime, getThread, setThread),
    };
  unreachable("toLiveTree: fan-out cannot appear inside a single-line position");
}

/** The node (in the enclosing level's own flow) that a position's innermost `use-descent` wrapper — if any — folds into; `undefined` at the root. Mirrors what `ReplayFrame.useNodeId` used to carry directly on the frame itself. */
function parentOf<TFrame>(path: PathLevel<TFrame>[]): NodeId | undefined {
  const enclosing = path[path.length - 2]?.node;
  return enclosing?.kind === "use-descent" ? enclosing.outerNode : undefined;
}

/**
 * Advances a flow exactly one node, reconstructing where it is purely from
 * `runtime.store` — no state may survive in a JS closure between calls, so a
 * fresh `Runtime` object (same store) resumes exactly like the original one.
 *
 * A `waitFor` that already has a matching message waiting is “free”: it’s
 * consumed and its edge followed inline, without counting as this tick’s one
 * step — so resuming at a `waitFor` and reaching `finish` in the same call
 * (no work left to run in between) reports `done`, not `advanced`.
 *
 * A fan-out node's branches advance one at a time across separate `tick`
 * calls instead of running every branch to completion in one `Promise.all`
 * like `runFlow` does — see `advanceFanOutGroup`.
 *
 * A `use` node is driven the same way tick() drives its own top-level graph:
 * one node at a time, on a child level wrapped in a `use-descent` tree node
 * (not forked — `use` shares its parent's thread, unlike a fan-out branch).
 * Reaching the subgraph's own `finish` unwraps that level and folds its
 * result into the enclosing one, exactly like `driveUseNode`'s own tail;
 * parking on the subgraph's own `waitFor` reports a cursor whose `parent` is
 * the `use` node's id, mirroring how a fan-out branch's cursor reports the
 * fan-out node as its parent.
 */
export async function tick(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  const attemptsByNode = new Map<NodeId, number>();
  const position = replayPosition(flow, runtime);

  if (position.kind === "fanout") {
    return advanceFanOutGroup(position.group, flow, runtime, attemptsByNode);
  }

  let currentThread: Thread = position.thread;
  let pendingInputs: unknown[] | undefined = position.pendingInputs;
  let ranStep = false;

  const getThread = (): Thread => currentThread;
  const setThread = (next: Thread): void => {
    currentThread = next;
  };

  let tree: CursorTree<LiveFrame> = toLiveTree(position.tree, runtime, getThread, setThread);

  for (;;) {
    const path = cursorPath(flow, tree);
    const leaf = path[path.length - 1];
    if (!leaf) unreachable("tick: position path is empty");
    if (leaf.node.kind !== "step") unreachable("tick: innermost position is not a step");
    const frame = leaf.node.frame;
    const node = frame.flow.nodes.get(frame.current);
    if (!node) throw new Error(`graph "${frame.flow.name}" has no node "${frame.current}"`);
    const parentNode = parentOf(path);
    const parent = parentNode !== undefined ? { parent: parentNode } : {};

    if (node.kind === "finish") {
      if (path.length === 1) {
        return [{ node: frame.current, status: "done", result: frame.currentInput }];
      }
      // Unwrap: fold this level's terminal value back into the enclosing
      // one, exactly like driveUseNode's own tail — a single output event
      // tagged with the *outer* use node's id, then follow its edge.
      const enclosing = path[path.length - 2];
      if (enclosing?.node.kind !== "use-descent")
        unreachable("tick: enclosing position missing its use-descent wrapper");
      const useNodeId = enclosing.node.outerNode;
      const routed = commitRoute(
        runtime,
        currentThread.id,
        enclosing.flow.edges,
        useNodeId,
        frame.currentInput,
        stepIdentity(useNodeId),
        currentThread,
      );
      currentThread = routed.thread;
      tree = rebuildFromPath(path, path.length - 2, {
        kind: "step",
        frame: buildLiveFrame(
          {
            flow: enclosing.flow,
            current: routed.to,
            currentInput: routed.input,
            reason: routed.reason,
          },
          runtime,
          getThread,
          setThread,
        ),
      });
      continue;
    }

    if (node.kind === "waitFor") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];
      const kinds = [
        node.messageKind,
        ...frame.interrupts.map((interrupt) => interrupt.messageKind),
      ];
      const message = runtime.store.consume(
        (candidate) => candidate.kind !== undefined && kinds.includes(candidate.kind),
      );
      if (!message)
        return [{ node: frame.current, status: "parked", waitingFor: kinds, ...parent }];

      const routed = await driveWaitForMessage(
        message,
        frame.current,
        frame.interrupts,
        frame.context,
        frame.flow,
        runtime,
        setThread,
      );
      currentThread = routed.thread;
      frame.current = routed.to;
      frame.currentInput = routed.input;
      frame.reason = routed.reason;
      // A "free" waitFor (consumed a message but no interrupt fired) doesn't
      // count toward this tick's one-step budget — only an interrupt running
      // is billable work; see tick()'s own doc comment.
      if (routed.ranInterruptStep) ranStep = true;
      continue;
    }

    if (node.kind === "use") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];

      const { seed, thread: seededThread } = seedUseNode(
        frame.reason,
        frame.currentInput,
        currentThread,
        runtime,
      );
      currentThread = seededThread;

      tree = rebuildFromPath(path, path.length - 1, {
        kind: "use-descent",
        outerNode: frame.current,
        inner: {
          kind: "step",
          frame: buildLiveFrame(
            { flow: node.subgraph, current: node.subgraph.entry, currentInput: seed },
            runtime,
            getThread,
            setThread,
          ),
        },
      });
      continue;
    }

    if (node.kind !== "step") notImplemented(`tick: node kind "${node.kind}"`);

    if (ranStep) return [{ node: frame.current, status: "active", ...parent }];

    if (node.label) currentThread = { ...currentThread, label: node.label };

    const inputs = pendingInputs ?? [frame.currentInput];
    pendingInputs = undefined;

    // Validate JoinStep tagging the same way driveGraph does for runFlow —
    // see assertJoinTagging.
    assertJoinTagging(frame.current, node.run, inputs);

    const stepContext: StepContext = withInputs(frame.context, inputs);
    const emit = await runStep(node.run, stepContext);

    if ("output" in emit) {
      const branchTargets = fanOutTargets(frame.flow, frame.current);
      if (branchTargets.length > 1) {
        // Same detection driveStepEmit uses (fanOutTargets), but tick spawns
        // per-branch cursors instead of running every branch to completion in
        // one Promise.all — see advanceFanOutGroup. Only ever reconstructed at
        // the outermost level — see replayPosition's own matching guard.
        if (path.length > 1) notImplemented("tick: fan-out inside a used subgraph");
        appendOutput(
          runtime,
          currentThread.id,
          emit.output,
          stepIdentity(frame.current, node.label),
        );
        const group: FanOutGroup = buildFanOutGroup(
          branchTargets,
          frame.current,
          frame.flow,
          currentThread,
          emit.output,
        );
        return group.branches.map((branch) => branchCursorState(branch, group));
      }
    }

    const outcome = await driveStepEmit(emit, node, frame.current, {
      flow: frame.flow,
      runtime,
      thread: currentThread,
      attemptsByNode,
    });

    if (outcome.kind === "retry") continue;
    if (outcome.pendingInputs)
      unreachable("tick: driveStepEmit reported a fan-out after tick's own check ruled it out");

    currentThread = outcome.thread;
    frame.currentInput = outcome.input;
    frame.reason = outcome.reason;
    frame.current = outcome.to;
    ranStep = true;
  }
}

/** Calls `tick` until it stops advancing — every cursor either parked or done. */
export async function tickUntilSuspended(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  for (;;) {
    const outcome = await tick(flow, runtime);
    if (outcome.every((cursor) => cursor.status !== "active")) return outcome;
  }
}
