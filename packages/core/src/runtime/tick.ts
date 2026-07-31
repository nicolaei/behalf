// Tick and replay: reconstructs where a flow last left off purely from the
// event log, advances it exactly one node, and the `tickUntilSuspended`
// helper that repeats until every cursor is parked or done.

import type { Graph, NodeId, NodeKind } from "../graph/graph.js";
import type { ThreadId } from "../graph/thread.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8: thread extraction) tick's replay folds ai-shaped Message/MessageKind; removed when message replay moves to ai's reducers.
import type { Message, MessageKind } from "../ai/message.js";
import { tryMessageKindOf } from "../graph/waitable.js";
import type { StepContext, WaitForResult } from "../graph/step.js";
import { ModelCallAbortedError } from "../graph/step.js";
import type { Event } from "../session/event.js";
import type { CommittedEnvelope, Envelope } from "../session/envelope.js";
import type { Runtime } from "./runtime.js";
import { freshThreadId } from "./ids.js";
import { notImplemented, unreachable } from "./errors.js";
import {
  type Thread,
  stepIdentity,
  appendOutput,
  route,
  commitRoute,
  withMessage,
  thenEdges,
  StateTracker,
  withCompaction,
  applyThreadAction,
} from "./routing.js";
import { runStep, assertJoinTagging, withInputs, ExecutionScope } from "./step-runner.js";
import {
  type FanOutGroup,
  buildFanOutGroup,
  foldGroup,
  replayBranchOutput,
  replayBranchMessage,
  replayBranchSignal,
  advanceFanOutGroup,
  branchCursorState,
} from "./fan-out.js";
import {
  type InterruptNode,
  buildDriveContext,
  driveStepEmit,
  runWaitForNode,
  peekingMessageSource,
  fanOutTargets,
  findInterruptNodes,
  seedUseNode,
  commitInvalidation,
} from "./drive.js";
import { buildForEachGroup, replayForEachBranch, advanceForEachGroup } from "./foreach.js";

/** One cursor's current state within a tick() outcome — node, status, and (for parked) what it's waiting for. */
export interface CursorState {
  node: NodeId;
  status: "active" | "parked" | "done";
  // Present only when status is "parked". A known overload: for a userInput-based
  // wait, these are message kinds a real message could carry; for a signal-based
  // wait, this instead holds the Waitable's own `label` (its display identifier),
  // not a message kind at all. It compiles either way because `MessageKind` is
  // just `string` underneath, with no way for a reader to tell the two apart from
  // the type alone. Deliberately deferred: distinguishing them for real would
  // need a breaking change to this public shape, out of scope for this pass.
  waitingFor?: MessageKind[];
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
 * replacing the position at whatever depth it occurred — the tree's root
 * for a top-level fan-out, or nested under one or more `use-descent`s for a
 * fan-out inside a used subgraph. Parameterized over the frame shape so the
 * same shape serves both replay (`ReplayFrame`) and tick's live walk
 * (`LiveFrame`).
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
  // order, mirroring driveStepEmit's own `pendingInputs`. Set regardless of
  // whether that fan-out was at the outermost level or nested inside a
  // used subgraph — see `advanceFanOutGroup`.
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
 * ordinary single-line replay from there. This works at any depth — a
 * fan-out reconstructed while inside a use-descent builds the group as that
 * level's own tree node (see the `leaf.node.kind === "fan-out"` handling
 * below), matching tick()'s own live handling of the same nesting.
 *
 * A `use` node's subgraph shares its parent's thread (never forked), so
 * thread identity says nothing about whether a given event belongs to the
 * outer flow or a nested descent — only the event's own node id does. Every
 * node in one composed graph tree gets an id unique across every nesting
 * level of that tree (see flow/graph.ts's `nodeIdSequence` — nested builds
 * draw from the enclosing build's running counter, and `Flow.use` reserves a
 * pre-built subgraph's ids before allocating its own), so an output event's
 * `stepId` belongs to exactly one level of the current descent path;
 * `cursorPath` mirrors the `use` descents a live tick() call would
 * have made: a level is added the moment a `message` event seeds a `use`
 * node's subgraph, and levels below an enclosing owner are dropped the
 * moment an output event turns up whose id belongs to that enclosing level
 * instead — the completion event `commitOutput` tags with the `use` node's
 * own (outer) id once its subgraph reaches `finish`. A `forEach` branch
 * graph is the one deliberate exception to tree-wide id uniqueness (built at
 * runtime as its own outermost build, its ids CAN coincide with main-path
 * ids) — its events are excluded from this id search by thread id instead;
 * see the forEach handling in the replay loop below.
 */

/** `replayPosition`'s own mutable working state — the thread and position tree it's rebuilding, threaded through each per-event-type handler by reference so every handler sees (and can advance) exactly where the previous one left off. */
interface ReplayState {
  thread: Thread;
  tree: CursorTree;
}

/** `replayPosition`'s handling of an event while the innermost position is a still-in-flight fan-out group: folds an `output`/`message` event into whichever branch owns it, or — for the join node's own output — recognizes the fold already happened on an earlier tick call and resumes ordinary single-line replay from its routed edge. */
function applyFanOutEvent(
  envelope: CommittedEnvelope,
  path: PathLevel<ReplayFrame>[],
  group: FanOutGroup,
  ownerFlow: Graph,
  runtime: Runtime,
  state: ReplayState,
): void {
  if (envelope.type === "output") {
    const { value } = envelope.event as Event["output"];
    const stepId = envelope.stepId as NodeId;
    if (stepId === group.joinNodeId) {
      // The join already ran on an earlier tick call: the group folded
      // in the log itself. Resume ordinary single-line replay from here,
      // rebuilding whatever use-descent wrapping led to this depth.
      state.thread = group.mainThread;
      const routed = route(ownerFlow.edges, stepId, value, state.thread, runtime);
      state.thread = routed.thread;
      state.tree = rebuildFromPath(path, path.length - 1, {
        kind: "step",
        frame: {
          flow: ownerFlow,
          current: routed.to,
          currentInput: routed.input,
          reason: routed.reason,
        },
      });
    } else {
      replayBranchOutput(group, envelope.threadId, stepId, value, ownerFlow);
    }
  }
  if (envelope.type === "message") {
    const { message } = envelope.event as Event["message"];
    replayBranchMessage(group, envelope.threadId, message, ownerFlow);
  }
  if (envelope.type === "signal") {
    replayBranchSignal(group, envelope.threadId, ownerFlow, runtime);
  }
  // toolCall/toolResult/compaction/invalidation/error inside a branch aren't
  // produced by any node kind `runBranchNode` supports — out of scope for
  // this slice's replay, same as the single-line path.
}

/** `replayPosition`'s handling of a committed `output` event outside an in-flight fan-out: finds the level that actually owns the node id (walking outward, since a level above may already have finished), then either hands off to per-branch fan-out reconstruction or routes to the next node the same way `advance` would. */
function applyOutputEvent(
  envelope: CommittedEnvelope,
  path: PathLevel<ReplayFrame>[],
  runtime: Runtime,
  state: ReplayState,
): void {
  const { value } = envelope.event as Event["output"];
  const stepId = envelope.stepId as NodeId;

  // Find the level that actually owns this node id, from the innermost
  // level outward. Node ids are unique across every nesting level of one
  // composed graph tree (see flow/graph.ts's nodeIdSequence), so exactly
  // one level ever recognizes a given id; landing on an ENCLOSING
  // level's own id (rather than the innermost one's) means every level
  // above it already reached its own `finish` — each logged its own
  // such completion event first — so rebuilding the tree back to that
  // depth is simply catching up on pops a live tick() call already made.
  let depth = path.length - 1;
  for (; depth >= 0; depth -= 1) {
    if (path[depth]?.flow.nodes.has(stepId)) break;
  }
  if (depth < 0) return; // inner noise no known level owns — skip
  const owner: PathLevel<ReplayFrame> | undefined = path[depth];
  if (!owner) unreachable("replayPosition: owner missing after depth search");
  const ownerFlow = owner.flow;

  const branchTargets = thenEdges(ownerFlow.edges, stepId).map((edge) => edge.to);
  if (branchTargets.length > 1) {
    // A fan-out node's own output: hand off to per-branch reconstruction
    // instead of `advance`, which would silently pick just the first
    // branch (see `selectEdge`) and desync from what actually ran.
    // `rebuildFromPath` rewraps whatever use-descents sit above this
    // depth unchanged, so this works whether the fan-out is at the
    // outermost level or nested inside a used subgraph.
    state.tree = rebuildFromPath(path, depth, {
      kind: "fan-out",
      group: buildFanOutGroup(branchTargets, stepId, ownerFlow, state.thread, value),
    });
    return;
  }

  const routed = route(ownerFlow.edges, stepId, value, state.thread, runtime);
  state.thread = routed.thread;
  state.tree = rebuildFromPath(path, depth, {
    kind: "step",
    frame: {
      flow: ownerFlow,
      current: routed.to,
      currentInput: routed.input,
      reason: routed.reason,
    },
  });
}

/** `replayPosition`'s handling of a committed `message` event: a `waitFor` node that consumed it routes off the message, same as `advance`; a `use` node being seeded descends a level into its subgraph; any other current node folds the message's content onto `state.thread` (same as `applyCompactionEvent`/`applyInvalidationEvent` already do for their own event types) without moving any level's position — content-folding is orthogonal to position tracking, which is all the waitFor/use special-casing above ever protected. */
function applyMessageEvent(
  envelope: CommittedEnvelope,
  path: PathLevel<ReplayFrame>[],
  leaf: PathLevel<ReplayFrame>,
  runtime: Runtime,
  state: ReplayState,
): void {
  const { message } = envelope.event as Event["message"];
  if (leaf.node.kind !== "step") unreachable("replayPosition: innermost position is not a step");
  const topFrame = leaf.node.frame;
  const node = leaf.flow.nodes.get(topFrame.current);

  if (node?.kind === "waitFor") {
    state.thread = withMessage(state.thread, message);
    const routed = route(leaf.flow.edges, topFrame.current, message, state.thread, runtime);
    state.thread = routed.thread;
    state.tree = rebuildFromPath(path, path.length - 1, {
      kind: "step",
      frame: {
        flow: leaf.flow,
        current: routed.to,
        currentInput: { ok: true, result: message } satisfies WaitForResult,
        reason: routed.reason,
      },
    });
    return;
  }

  if (node?.kind === "use") {
    // Entering this use node's subgraph: mirrors driveUseNode's own seed
    // dedup (a "same"-threadAction reaching edge already pushed this
    // message onto the thread; this event just echoes it into the log)
    // and descends a level at the subgraph's own entry, seeded with this
    // exact message — the same value `driveGraph`'s own `input`
    // parameter would carry.
    if (!topFrame.reason) state.thread = withMessage(state.thread, message);
    state.tree = rebuildFromPath(path, path.length - 1, {
      kind: "use-descent",
      outerNode: topFrame.current,
      inner: {
        kind: "step",
        frame: { flow: node.subgraph, current: node.subgraph.entry, currentInput: message },
      },
    });
    return;
  }
  // Belongs to a node this replay isn't tracking as any level's `current` —
  // never needs to move a level's position — but its CONTENT still belongs
  // on the thread: an ordinary step logging a message directly (modelCall's
  // own reply, `fold`'s combined tool-result message, `appendEvent` calls in
  // general) is exactly this case, and skipping the fold here would silently
  // drop it from `thread.messages` on every replay that lands past it.
  state.thread = withMessage(state.thread, message);
}

/** `replayPosition`'s handling of a committed `signal` event: only ever moves the position when the innermost node is a non-message `waitFor` whose `Waitable` now matches the log up to and including this event — mirrors `applyMessageEvent`'s `waitFor` case, but the value routed downstream is `match()`'s own result rather than the raw event. */
function applySignalEvent(
  path: PathLevel<ReplayFrame>[],
  leaf: PathLevel<ReplayFrame>,
  runtime: Runtime,
  state: ReplayState,
): void {
  if (leaf.node.kind !== "step") return;
  const topFrame = leaf.node.frame;
  const node = leaf.flow.nodes.get(topFrame.current);
  if (node?.kind !== "waitFor" || tryMessageKindOf(node.waitable) !== undefined) return;

  const matched = node.waitable.match(runtime.store.events());
  if (matched === undefined) return;

  const routed = route(
    leaf.flow.edges,
    topFrame.current,
    { ok: true, result: matched } satisfies WaitForResult,
    state.thread,
    runtime,
  );
  state.thread = routed.thread;
  state.tree = rebuildFromPath(path, path.length - 1, {
    kind: "step",
    frame: {
      flow: leaf.flow,
      current: routed.to,
      currentInput: { ok: true, result: matched } satisfies WaitForResult,
      reason: routed.reason,
    },
  });
}

/** `replayPosition`'s handling of a committed `compaction` event: folds it into `state.thread` via `withCompaction`, the same derivation the live drive applies when `compact()` actually runs (see `commitCompaction`). Never moves the position tree — a compaction is always logged alongside its step's own `output` event, which is what advances the position; this only has to keep `thread.messages` correct for whatever runs next. */
function applyCompactionEvent(envelope: CommittedEnvelope, state: ReplayState): void {
  const compaction = envelope.event as Event["compaction"];
  state.thread = withCompaction(state.thread, compaction);
}

/**
 * `replayPosition`'s handling of a committed `invalidation` event: the same structural gap
 * `compaction` had before Phase 1 — `commitInvalidation` never logs an `output` event for the
 * step that invalidated, so replay has nothing else to recognize that step as already-completed.
 * Routes straight to a target, applying the event's own `threadAction`/`reason` the same way
 * `commitInvalidation` did live, instead of falling through and leaving the position sitting on
 * the invalidating step (which would re-run it, re-invalidating on every subsequent replay).
 *
 * `cause === "abort"` (set only by `routeAbort`) marks a target logged by whatever process was
 * running at abort time. When this mechanism shipped, node ids were only unique per PROCESS —
 * never stable across separate constructions of the "same" graph — so a logged abort target
 * crossing a process boundary was a foreign number: trusting it the way an ordinary
 * invalidate's target can be trusted (see below) either found nothing in any frame (crashed)
 * or, worse, matched an unrelated node by coincidence. Node ids ARE deterministic across
 * builds now (see flow/graph.ts's `nodeIdSequence`), but stores already written under the old
 * scheme still hold foreign ids, and re-deriving costs nothing when ids do match — so instead
 * of matching a number, this re-derives the target the exact way `routeAbort` decided it live:
 * walk `path` innermost-first for the first frame that declares its own `flow.onAbort`, and
 * land on THAT frame's OWN onAbort node — a real id in THIS process's own graph, never a
 * foreign one.
 *
 * An ordinary `context.invalidate(...)` has no such problem: its target always belongs to the
 * invalidating step's OWN graph (the leaf), logged and replayed within the SAME process's SAME
 * graph construction — unlike an abort, nothing about it ever crosses a process boundary, so the
 * old leaf-only reuse (matching `target` against `path`, innermost-first, same as `applyOutputEvent`)
 * still applies unchanged.
 */
function applyInvalidationEvent(
  envelope: CommittedEnvelope,
  path: PathLevel<ReplayFrame>[],
  runtime: Runtime,
  state: ReplayState,
): void {
  const { target, threadAction, reason, cause } = envelope.event as Event["invalidation"];
  state.thread = applyThreadAction(state.thread, threadAction, reason, runtime);

  // Walks path innermost-first for the first frame declaring its own
  // flow.onAbort, landing there — the same decision routeAbort made live.
  // Returns whether one was found; doesn't throw, so a caller can fall
  // back to a different strategy first.
  function routeViaOnAbort(): boolean {
    for (let depth = path.length - 1; depth >= 0; depth -= 1) {
      const owner = path[depth];
      const onAbortTarget = owner?.flow.onAbort;
      if (!owner || onAbortTarget === undefined) continue;
      state.tree = rebuildFromPath(path, depth, {
        kind: "step",
        frame: { flow: owner.flow, current: onAbortTarget, currentInput: undefined },
      });
      return true;
    }
    return false;
  }

  if (cause === "abort") {
    if (!routeViaOnAbort()) {
      unreachable("replayPosition: aborted invalidation but no frame in path declares onAbort");
    }
    return;
  }

  let depth = path.length - 1;
  for (; depth >= 0; depth -= 1) {
    if (path[depth]?.flow.nodes.has(target)) break;
  }
  const owner = depth >= 0 ? path[depth] : undefined;
  if (owner) {
    state.tree = rebuildFromPath(path, depth, {
      kind: "step",
      frame: { flow: owner.flow, current: target, currentInput: undefined },
    });
    return;
  }

  // No frame owns the logged target at all — an ordinary invalidate's
  // target always belongs to the invalidating step's own graph by
  // construction, so a total miss here isn't really an ordinary invalidate
  // gone wrong; it's almost certainly a graph-level abort logged before
  // `cause` existed (or a store written by a version of this fix's own
  // pre-release). Retry via the same onAbort walk before giving up, so
  // sessions with old, untagged abort data already on disk resume too,
  // not just ones aborted after this landed.
  if (!routeViaOnAbort()) {
    unreachable("replayPosition: invalidation target belongs to no frame");
  }
}

/**
 * Reconstructs `tick`'s own `StateTracker` purely from the committed log —
 * mirrors `replayPosition`'s own reconstruction of cursor position: no state
 * may survive between separate `tick()` calls except what's already in the
 * log. Walks every committed `stateChange` event in order, keeping only the
 * latest `to` per thread — `from` never matters here, since a freshly
 * rebuilt tracker only needs "what's the last state this thread saw", not
 * how it got there.
 */
function replayStateTracker(events: readonly Envelope[]): StateTracker {
  const lastState = new Map<ThreadId, string>();
  for (const envelope of events) {
    if (envelope.form !== "committed" || envelope.type !== "stateChange") continue;
    if (!envelope.threadId) continue; // stateChange always carries one; guard satisfies the type
    const { to } = envelope.event as Event["stateChange"];
    lastState.set(envelope.threadId, to);
  }
  return new StateTracker(lastState);
}

function replayPosition(flow: Graph, runtime: Runtime): ReplayResult {
  const state: ReplayState = {
    thread: { id: freshThreadId(runtime), messages: [], history: [] },
    tree: { kind: "step", frame: { flow, current: flow.entry, currentInput: undefined } },
  };

  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;

    // Resolve the current position's innermost node before anything else —
    // it may be a still-in-flight fan-out (root or nested inside one or more
    // use-descents), which needs its own per-branch handling below instead of
    // the ordinary step/message dispatch.
    const path: PathLevel<ReplayFrame>[] = cursorPath(flow, state.tree);
    const leaf = path[path.length - 1];
    if (!leaf) unreachable("replayPosition: position path is empty");

    if (leaf.node.kind === "fan-out") {
      applyFanOutEvent(envelope, path, leaf.node.group, leaf.flow, runtime, state);
      continue;
    }

    // A forEach node's branches each run on their own per-branch thread (see
    // foreach.ts), and every event they commit is tagged with that thread —
    // never the main line's. While the position is parked at a forEach node,
    // those branch events must NOT move `state.thread`: the forEach fold
    // (advanceTickForEachNode's commitRoute) reads it back as the thread the
    // folded `output` event is committed on, and it has to stay the outer
    // flow's own thread. Skip the correction here, the same way the fan-out
    // case above never runs it. The fold's own edge is followed by `route`,
    // which carries the thread forward correctly without this blanket sync.
    const atForEach =
      leaf.node.kind === "step" && leaf.flow.nodes.get(leaf.node.frame.current)?.kind === "forEach";
    if (!atForEach && envelope.threadId) state.thread = { ...state.thread, id: envelope.threadId };

    if (envelope.type === "output") {
      // A branch's own step outputs (committed on its deterministic branch
      // thread, never the main line's) are replayed per-branch by
      // `replayForEachBranch` — never here. They used to fall out of
      // `applyOutputEvent`'s id search by accident (branch graphs once drew
      // globally unique ids, so no level ever owned one); now that a branch
      // graph is rebuilt as its own outermost build (see flow/graph.ts's
      // nodeIdSequence), a branch node's id CAN coincide with a main-path
      // node's, so they must be excluded by thread id instead of by an
      // id-membership miss.
      if (atForEach && envelope.threadId !== undefined && envelope.threadId !== state.thread.id)
        continue;
      applyOutputEvent(envelope, path, runtime, state);
      continue;
    }

    if (envelope.type === "message") {
      applyMessageEvent(envelope, path, leaf, runtime, state);
      continue;
    }

    if (envelope.type === "signal") {
      applySignalEvent(path, leaf, runtime, state);
      continue;
    }

    if (envelope.type === "compaction") {
      applyCompactionEvent(envelope, state);
      continue;
    }

    if (envelope.type === "invalidation") {
      applyInvalidationEvent(envelope, path, runtime, state);
      continue;
    }
    // toolCall/toolResult/error don't move the main position on their own
    // — out of scope for this slice's replay.
  }

  const finalPath = cursorPath(flow, state.tree);
  const finalLeaf = finalPath[finalPath.length - 1];
  if (!finalLeaf) unreachable("replayPosition: final position path is empty");

  if (finalLeaf.node.kind === "fan-out") {
    const group = finalLeaf.node.group;
    const folded = foldGroup(group);
    if (folded) {
      return {
        kind: "single",
        thread: group.mainThread,
        tree: rebuildFromPath(finalPath, finalPath.length - 1, {
          kind: "step",
          frame: { flow: finalLeaf.flow, current: folded.current, currentInput: undefined },
        }),
        pendingInputs: folded.pendingInputs,
      };
    }
    // Still in flight once the log runs out. At the outermost level tick()
    // has a dedicated fast path (`position.kind === "fanout"`, see `tick`
    // below) that skips the live tree entirely; nested inside a used
    // subgraph, the tree already carries the fan-out in place and tick()'s
    // own live loop advances it from there (see its matching
    // `leaf.node.kind === "fan-out"` branch).
    if (finalPath.length === 1) return { kind: "fanout", group };
    return { kind: "single", thread: state.thread, tree: state.tree };
  }

  return { kind: "single", thread: state.thread, tree: state.tree };
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

/** Converts a replayed position tree into a live one, wiring each `step` leaf's `LiveFrame` and preserving every `use-descent` wrapper unchanged. A `fan-out` node is passed through as-is — its `group` doesn't depend on the frame type parameter, and `tick`'s own live loop (not this function) is what advances it, whether it's the tree's root or nested inside a `use-descent`. */
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
  return { kind: "fan-out", group: tree.group };
}

/** The node (in the enclosing level's own flow) that a position's innermost `use-descent` wrapper — if any — folds into; `undefined` at the root. Mirrors what `ReplayFrame.useNodeId` used to carry directly on the frame itself. */
function parentOf<TFrame>(path: PathLevel<TFrame>[]): NodeId | undefined {
  const enclosing = path[path.length - 2]?.node;
  return enclosing?.kind === "use-descent" ? enclosing.outerNode : undefined;
}

/** `tick()`'s own `use` node handling: seeds the subgraph from the outer frame's current input/reason (`seedUseNode`), then wraps it in a `use-descent` tree node ready for the loop's next iteration to drive — same descent `driveUseNode` builds for `runFlow`, just captured as data instead of an immediate recursive call. */
function advanceTickUseNode(
  node: Extract<NodeKind, { kind: "use" }>,
  frame: LiveFrame,
  currentThread: Thread,
  path: PathLevel<LiveFrame>[],
  runtime: Runtime,
  getThread: () => Thread,
  setThread: (thread: Thread) => void,
): { thread: Thread; tree: CursorTree<LiveFrame> } {
  const { seed, thread: seededThread } = seedUseNode(
    frame.reason,
    frame.currentInput,
    currentThread,
    runtime,
  );

  const tree = rebuildFromPath(path, path.length - 1, {
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

  return { thread: seededThread, tree };
}

/** `tick()`'s own `forEach` node handling: builds and replays the group's branches, folding to the join (mutating `frame` in place, same as tick()'s own step-folding elsewhere) the instant every branch is done, or handing off to `advanceForEachGroup` for one more branch-step of work otherwise. */
async function advanceTickForEachNode(
  node: Extract<NodeKind, { kind: "forEach" }>,
  frame: LiveFrame,
  currentThread: Thread,
  runtime: Runtime,
  scope: ExecutionScope,
): Promise<{ kind: "folded"; thread: Thread } | { kind: "outcome"; outcome: TickOutcome }> {
  const group = buildForEachGroup(node, frame.current, currentThread, frame.currentInput, runtime);
  for (const branch of group.branches) replayForEachBranch(branch, group, runtime);

  if (group.branches.every((branch) => branch.done)) {
    const outputs = group.branches.map((branch) => branch.output);
    const routed = commitRoute(
      runtime,
      currentThread.id,
      frame.flow.edges,
      frame.current,
      outputs,
      stepIdentity(frame.current),
      currentThread,
    );
    frame.current = routed.to;
    frame.currentInput = routed.input;
    frame.reason = routed.reason;
    return { kind: "folded", thread: routed.thread };
  }

  return { kind: "outcome", outcome: await advanceForEachGroup(group, runtime, scope) };
}

/**
 * Routes an aborted model call to the nearest declared `onAbort` target,
 * bubbling outward through `use()`-embedding frames. Walks the live position
 * `path` from the innermost frame (whose step just aborted) outward: the first
 * frame whose graph declares `flow.onAbort` wins, and execution jumps to that
 * target on the SAME thread — synthesizing the exact outcome a
 * `context.invalidate(target, { threadAction: "same" })` call would have
 * produced and committing it through the shared `commitInvalidation`, so an
 * abort and an explicit invalidate reach `commitInvalidation` by one path. A
 * `use()`-embedded subgraph (e.g. `agentTurn`) that declares no `onAbort` of
 * its own therefore falls through to its enclosing graph's. Returns
 * `undefined` when nobody in the chain declared one — the caller then falls
 * back to the ordinary fail-the-run error path (driveStepEmit ->
 * handleStepError), byte-for-byte today's behavior for graphs that never opt
 * in. Node ids are unique across every level of one composed graph tree (see
 * flow/graph.ts's nodeIdSequence), so truncating the tree to the
 * winning frame's depth (dropping any inner frames) lands the position
 * squarely in the graph that owns the target — the same reconstruction
 * `applyInvalidationEvent` performs on a fresh replay.
 */
function routeAbort(
  path: PathLevel<LiveFrame>[],
  currentThread: Thread,
  runtime: Runtime,
  getThread: () => Thread,
  setThread: (thread: Thread) => void,
): { thread: Thread; tree: CursorTree<LiveFrame> } | undefined {
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const owner = path[depth];
    const target = owner?.flow.onAbort;
    if (!owner || target === undefined) continue;
    const outcome = commitInvalidation(
      runtime,
      currentThread,
      { invalidate: target, threadAction: "same" },
      "abort",
    );
    if (outcome.kind !== "advance") unreachable("routeAbort: commitInvalidation must advance");
    const tree = rebuildFromPath(path, depth, {
      kind: "step",
      frame: buildLiveFrame(
        {
          flow: owner.flow,
          current: outcome.to,
          currentInput: outcome.input,
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        },
        runtime,
        getThread,
        setThread,
      ),
    });
    return { thread: outcome.thread, tree };
  }
  return undefined;
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
  // No state may survive between separate tick() calls except what's in the
  // log itself — same reconstruct-from-the-log discipline `replayPosition`
  // applies to cursor position (see `replayStateTracker`'s own doc comment).
  const stateTracker = replayStateTracker(runtime.store.events());
  const scope = new ExecutionScope(attemptsByNode, stateTracker);
  const position = replayPosition(flow, runtime);

  if (position.kind === "fanout") {
    return advanceFanOutGroup(position.group, flow, runtime, scope);
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

    if (leaf.node.kind === "fan-out") {
      // A still-in-flight fan-out, root or nested inside a use-descent:
      // advance exactly one branch (or fold to the join once every branch
      // has reported), the same one-tick-call unit of work the outermost
      // fast path above uses. Branch cursors already carry their own
      // `parent` (the fan-out node id, from `branchCursorState`); only the
      // folded, parent-less "active" cursor needs tagging with this level's
      // own enclosing use node, matching how an ordinary step cursor at
      // this depth would be tagged (see `parentOf`).
      const outcome = await advanceFanOutGroup(leaf.node.group, leaf.flow, runtime, scope);
      const parentNode = parentOf(path);
      if (parentNode === undefined) return outcome;
      return outcome.map((cursor) =>
        cursor.parent !== undefined ? cursor : { ...cursor, parent: parentNode },
      );
    }

    if (leaf.node.kind !== "step") unreachable("tick: innermost position is not a step");
    const frame = leaf.node.frame;
    const node = frame.flow.nodes.get(frame.current);
    if (!node) throw new Error(`graph "${frame.flow.name}" has no node "${frame.current}"`);
    // A state-less node is invisible to the state machine; a declared
    // `state` fires (or not) exactly once per node visit here, before
    // dispatching to this node's own kind-specific handling below — mirrors
    // driveGraph's own top-of-loop check, so state fires on tick's very
    // first call too, not just once cross-call persistence (via
    // `replayStateTracker` above) has something to dedupe against.
    stateTracker.maybeEmit(
      runtime,
      currentThread.id,
      node.state,
      stepIdentity(frame.current, node.label),
    );
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
      // The one shared waitFor implementation (see drive.ts's `runWaitForNode`)
      // parameterized by tick()'s own non-blocking `MessageSource`: a single
      // peek, reporting "parked" instead of waiting when nothing's ready yet.
      const outcome = await runWaitForNode(
        node,
        frame.current,
        {
          interrupts: frame.interrupts,
          context: frame.context,
          flow: frame.flow,
          runtime,
          setThread,
          stateTracker,
        },
        peekingMessageSource(runtime),
      );

      if (outcome.kind === "parked") {
        return [
          { node: frame.current, status: "parked", waitingFor: outcome.waitingFor, ...parent },
        ];
      }

      currentThread = outcome.thread;
      frame.current = outcome.to;
      frame.currentInput = outcome.input;
      frame.reason = outcome.reason;
      // A "free" waitFor (consumed a message but no interrupt fired) doesn't
      // count toward this tick's one-step budget — only an interrupt running
      // is billable work; see tick()'s own doc comment.
      if (outcome.ranInterruptStep) ranStep = true;
      continue;
    }

    if (node.kind === "use") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];
      const advanced = advanceTickUseNode(
        node,
        frame,
        currentThread,
        path,
        runtime,
        getThread,
        setThread,
      );
      currentThread = advanced.thread;
      tree = advanced.tree;
      continue;
    }

    if (node.kind === "forEach") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];
      const advanced = await advanceTickForEachNode(node, frame, currentThread, runtime, scope);
      if (advanced.kind === "outcome") return advanced.outcome;
      currentThread = advanced.thread;
      ranStep = true;
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

    // Graph-level abort: a step that failed because its in-flight model call
    // was preempted by an abort message routes to the nearest declared
    // onAbort target instead of failing the run. `path` is this position's
    // frame stack innermost-first, so a use()'d subgraph that declares no
    // onAbort of its own bubbles out to its enclosing graph's declaration.
    if ("error" in emit && emit.error.cause instanceof ModelCallAbortedError) {
      const routed = routeAbort(path, currentThread, runtime, getThread, setThread);
      if (routed) {
        currentThread = routed.thread;
        tree = routed.tree;
        ranStep = true;
        continue;
      }
      // Nobody in the chain declared onAbort — fall through to today's
      // fail-the-run behavior via driveStepEmit -> handleStepError.
    }

    if ("output" in emit) {
      const branchTargets = fanOutTargets(frame.flow, frame.current);
      if (branchTargets.length > 1) {
        // Same detection driveStepEmit uses (fanOutTargets), but tick spawns
        // per-branch cursors instead of running every branch to completion in
        // one Promise.all — see advanceFanOutGroup. Works at any depth: the
        // returned branch cursors already carry their own `parent` (the
        // fan-out node id), and a resumed reconstruction of this same group
        // is handled by replayPosition's matching `leaf.node.kind === "fan-out"`
        // branch.
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
      // tick()'s own top-of-loop check above already fired this node's
      // state (or deduped it) before this step ran; this call's own scope
      // just needs to see the same stateTracker instance so a later dedupe
      // check inside driveStepEmit's fan-out branch handling (a fresh
      // tracker per forked branch, via `scope.fork()`) still sees this
      // thread's latest state as its starting point.
      scope,
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
