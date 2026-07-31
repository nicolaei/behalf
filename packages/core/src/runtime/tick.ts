// Tick and replay: reconstructs where a flow last left off purely from the
// event log, advances it exactly one node, and the `tickUntilSuspended`
// helper that repeats until every cursor is parked or done.

import type { Graph, NodeId, NodeKind } from "../graph/graph.js";
import type { ScopeId } from "../graph/thread.js";
import { tryMessageKindOf } from "../graph/waitable.js";
import type { StepContext, WaitForResult } from "../graph/step.js";
import { ModelCallAbortedError } from "../graph/step.js";
import type { Event } from "../session/event.js";
import type { CommittedEnvelope, Envelope } from "../session/envelope.js";
import type { Runtime } from "./runtime.js";
import { freshScopeId } from "./ids.js";
import { notImplemented, unreachable } from "./errors.js";
import {
  stepIdentity,
  appendOutput,
  route,
  commitRoute,
  thenEdges,
  StateTracker,
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
  // not a message kind at all. Deliberately deferred: distinguishing them for real
  // would need a breaking change to this public shape, out of scope for this pass.
  waitingFor?: string[];
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

/** Where a fresh replay of `runtime.store`'s committed events left off: the position tree plus the scope it shares throughout (a `use` node's subgraph never forks it) and any pending fan-out join inputs. */
interface ReplayPosition {
  scope: ScopeId;
  tree: CursorTree;
  // Set only when replay landed on a join node whose fan-out group just
  // folded (every branch reported) — one entry per branch, in declared
  // order, mirroring driveStepEmit's own `pendingInputs`. Set regardless of
  // whether that fan-out was at the outermost level or nested inside a
  // used subgraph — see `advanceFanOutGroup`.
  pendingInputs?: unknown[];
}

/** What a fresh replay of `runtime.store` left off at: mid-flight on one line (`single`), spread across an in-flight fan-out group's branches (`fanout`), or — no `input` event committed yet — `not-started`: the session has no starting cursor at all, so `tick` just reports it parked (see the `Event["input"]` doc comment). */
type ReplayResult =
  | ({ kind: "single" } & ReplayPosition)
  | { kind: "fanout"; group: FanOutGroup }
  | { kind: "not-started" };

/** `replayPosition`'s own mutable working state — the scope and position tree it's rebuilding, threaded through each per-event-type handler by reference so every handler sees (and can advance) exactly where the previous one left off. */
interface ReplayState {
  scope: ScopeId;
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
      state.scope = group.mainScope;
      const routed = route(ownerFlow.edges, stepId, value, state.scope);
      state.scope = routed.scope;
      state.tree = rebuildFromPath(path, path.length - 1, {
        kind: "step",
        frame: {
          flow: ownerFlow,
          current: routed.to,
          currentInput: routed.input,
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
      group: buildFanOutGroup(branchTargets, stepId, ownerFlow, state.scope, value),
    });
    return;
  }

  const routed = route(ownerFlow.edges, stepId, value, state.scope);
  state.scope = routed.scope;
  state.tree = rebuildFromPath(path, depth, {
    kind: "step",
    frame: {
      flow: ownerFlow,
      current: routed.to,
      currentInput: routed.input,
    },
  });
}

/** `replayPosition`'s handling of a committed `message` event: a `waitFor` node that consumed it routes off the message, same as `advance`; a `use` node being seeded descends a level into its subgraph; any other current node's own content is left entirely to whichever extension owns "message" (ai's own `state("ai")` fold, read on demand) — content-folding is no longer core's concern at all; this only ever moves a level's position, when the message is what a `waitFor`/`use` node was expecting. */
function applyMessageEvent(
  envelope: CommittedEnvelope,
  path: PathLevel<ReplayFrame>[],
  leaf: PathLevel<ReplayFrame>,
  state: ReplayState,
): void {
  const { message } = envelope.event as Event["message"];
  if (leaf.node.kind !== "step") unreachable("replayPosition: innermost position is not a step");
  const topFrame = leaf.node.frame;
  const node = leaf.flow.nodes.get(topFrame.current);

  if (node?.kind === "waitFor") {
    const routed = route(leaf.flow.edges, topFrame.current, message, state.scope);
    state.scope = routed.scope;
    state.tree = rebuildFromPath(path, path.length - 1, {
      kind: "step",
      frame: {
        flow: leaf.flow,
        current: routed.to,
        currentInput: { ok: true, result: message } satisfies WaitForResult,
      },
    });
    return;
  }

  if (node?.kind === "use") {
    // Entering this use node's subgraph — the same descent `driveUseNode`
    // performs, just captured as data here. The subgraph's entry sees
    // this event's own value as its input; any scope transition (an ai
    // `ctx.thread.start`/`fork` on the reaching edge's own `run` fn)
    // already happened before this event was even logged.
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
  // never needs to move a level's position. Its content (if any) is folded
  // by whichever extension owns "message", read on demand via `state()` —
  // nothing for core to do here.
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
    state.scope,
  );
  state.scope = routed.scope;
  state.tree = rebuildFromPath(path, path.length - 1, {
    kind: "step",
    frame: {
      flow: leaf.flow,
      current: routed.to,
      currentInput: { ok: true, result: matched } satisfies WaitForResult,
    },
  });
}

/**
 * `replayPosition`'s handling of a committed `invalidation` event: the same structural gap
 * `compaction` had before Phase 1 — `commitInvalidation` never logs an `output` event for the
 * step that invalidated, so replay has nothing else to recognize that step as already-completed.
 * Routes straight to a target — the scope resync itself is handled generically, by the top-of-loop
 * check against whichever event's own `threadId` comes next (an extension's `seedScope`-appended
 * event, or the target step's own next output) — instead of falling through and leaving the
 * position sitting on the invalidating step (which would re-run it, re-invalidating on every
 * subsequent replay).
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
  state: ReplayState,
): void {
  const { target, cause } = envelope.event as Event["invalidation"];

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
 * latest `to` per scope — `from` never matters here, since a freshly
 * rebuilt tracker only needs "what's the last state this scope saw", not
 * how it got there.
 */
function replayStateTracker(events: readonly Envelope[]): StateTracker {
  const lastState = new Map<ScopeId, string>();
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
    scope: freshScopeId(runtime),
    tree: { kind: "step", frame: { flow, current: flow.entry, currentInput: undefined } },
  };
  // Set only once, by the log's own `input` event (see `Event["input"]`'s
  // doc comment) — a log with no `input` event yet has no starting cursor at
  // all, distinct from "empty because nothing has happened since the first
  // event"; see the `kind: "not-started"` return below.
  let started = false;

  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;

    // Resolve the current position's innermost node before anything else —
    // it may be a still-in-flight fan-out (root or nested inside one or more
    // use-descents), which needs its own per-branch handling below instead of
    // the ordinary step/message dispatch.
    let path: PathLevel<ReplayFrame>[] = cursorPath(flow, state.tree);
    let leaf = path[path.length - 1];
    if (!leaf) unreachable("replayPosition: position path is empty");

    // Mirror the live loop's own use-descent (`advanceTickUseNode`): a position
    // that reached a `use` node descends into its subgraph immediately, and —
    // post thread-extraction — entering a use commits NO event of its own (the
    // old seed `message` append moved into ai's edge-run vocabulary), so replay
    // must reconstruct that same descent as data BEFORE dispatching the next
    // event. Without this, an inner node's own committed `output` events find no
    // owning level in `applyOutputEvent`'s path walk and are skipped as noise —
    // position never advances, and every later tick() re-runs the subgraph's
    // entry from scratch, forever (a multi-tick subgraph with a plain-step entry,
    // e.g. one that fans out, hangs `tickUntilSuspended` exactly that way).
    // Loops for a use-at-entry-of-a-use; only once `started`, since the `input`
    // event below is what establishes the real starting node.
    while (started && leaf.node.kind === "step") {
      const currentNode = leaf.flow.nodes.get(leaf.node.frame.current);
      if (currentNode?.kind !== "use") break;
      state.tree = rebuildFromPath(path, path.length - 1, {
        kind: "use-descent",
        outerNode: leaf.node.frame.current,
        inner: {
          kind: "step",
          frame: {
            flow: currentNode.subgraph,
            current: currentNode.subgraph.entry,
            currentInput: leaf.node.frame.currentInput,
          },
        },
      });
      path = cursorPath(flow, state.tree);
      const descended = path[path.length - 1];
      if (!descended) unreachable("replayPosition: path empty after use-descent");
      leaf = descended;
    }

    if (leaf.node.kind === "fan-out") {
      applyFanOutEvent(envelope, path, leaf.node.group, leaf.flow, runtime, state);
      continue;
    }

    // A forEach node's branches each run on their own per-branch scope (see
    // foreach.ts), and every event they commit is tagged with that scope —
    // never the main line's. While the position is parked at a forEach node,
    // those branch events must NOT move `state.scope`: the forEach fold
    // (advanceTickForEachNode's commitRoute) reads it back as the scope the
    // folded `output` event is committed on, and it has to stay the outer
    // flow's own scope. Skip the correction here, the same way the fan-out
    // case above never runs it. The fold's own edge is followed by `route`,
    // which carries the scope forward correctly without this blanket sync.
    const atForEach =
      leaf.node.kind === "step" && leaf.flow.nodes.get(leaf.node.frame.current)?.kind === "forEach";
    if (!atForEach && envelope.threadId) state.scope = envelope.threadId;

    if (envelope.type === "input" && !started) {
      // The session's own starting fact: establishes the starting cursor at
      // the named node with the given value — the ONE place that fold
      // happens for a session's own first value, replacing runFlow's old
      // separate pre-drive `message` commit (see runtime.ts's `seed`/
      // `runFlow`). Content-folding (if the value looks like a message) is
      // entirely an extension's own concern now, read back via `state()`.
      started = true;
      const { node, value } = envelope.event as Event["input"];
      state.tree = rebuildFromPath(path, path.length - 1, {
        kind: "step",
        frame: { flow: leaf.flow, current: node, currentInput: value },
      });
      continue;
    }

    if (envelope.type === "output") {
      // A branch's own step outputs (committed on its deterministic branch
      // scope, never the main line's) are replayed per-branch by
      // `replayForEachBranch` — never here. They used to fall out of
      // `applyOutputEvent`'s id search by accident (branch graphs once drew
      // globally unique ids, so no level ever owned one); now that a branch
      // graph is rebuilt as its own outermost build (see flow/graph.ts's
      // nodeIdSequence), a branch node's id CAN coincide with a main-path
      // node's, so they must be excluded by scope id instead of by an
      // id-membership miss.
      if (atForEach && envelope.threadId !== undefined && envelope.threadId !== state.scope)
        continue;
      applyOutputEvent(envelope, path, state);
      continue;
    }

    if (envelope.type === "message") {
      applyMessageEvent(envelope, path, leaf, state);
      continue;
    }

    if (envelope.type === "signal") {
      applySignalEvent(path, leaf, runtime, state);
      continue;
    }

    if (envelope.type === "invalidation") {
      applyInvalidationEvent(envelope, path, state);
      continue;
    }

    // Any event type that isn't one of core's own six (input/output/signal/stateChange/
    // invalidation/error — every one handled inline above) and isn't `message` (handled
    // inline above too, since a waitFor/use node consuming one also moves position) is
    // never structural to replay's own position tracking — no core action needed. An
    // extension's own `state()` fold reads it back on demand (today that's ai's
    // compaction/threadGenesis reducers); `toolCall`/`toolResult`/`error` remain no-ops,
    // same as before this generalized, since nothing registers a reducer for them.
  }

  // A `waitFor` entry already parks safely with `currentInput: undefined`
  // — it peeks the inbox/signal reactively, never reading `currentInput` as
  // its own value — so "no `input` event yet" is a real, resumable session
  // start for that shape alone (see `driveFlow`'s own doc comment: "a fresh
  // flow parks at its own entry waitFor until a message arrives"). Any other
  // entry kind would otherwise run live with a bogus `undefined` input, so
  // it genuinely has no starting cursor without a real `input` event.
  if (!started && flow.nodes.get(flow.entry)?.kind !== "waitFor") {
    return { kind: "not-started" };
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
        scope: group.mainScope,
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
    return { kind: "single", scope: state.scope, tree: state.tree };
  }

  return { kind: "single", scope: state.scope, tree: state.tree };
}

/** One level of tick()'s live execution — same shape as a `ReplayFrame`, plus what only matters while actually running: this level's own armed interrupts (recomputed per level, same as `driveGraph` does for every nested `driveGraph` call) and the `StepContext` its own nodes run with. */
interface LiveFrame {
  flow: Graph;
  interrupts: InterruptNode[];
  current: NodeId;
  currentInput: unknown;
  context: StepContext;
}

/** Builds a `LiveFrame` from a replayed one, wiring its `StepContext` to read this exact level's own (mutable) `current` through a closure over a holder cell — shared by the level's own `current` accessor and `buildDriveContext`, so a later tree rebuild only ever swaps which `CursorTree` node holds this frame, never anything `buildDriveContext` captured, and the frame is built complete and correctly-typed in one step (no incomplete-object cast). */
function buildLiveFrame(
  replayFrame: ReplayFrame,
  runtime: Runtime,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
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
    context: buildDriveContext(replayFrame.flow, runtime, () => holder.current, getScope, setScope),
  };
}

/** Converts a replayed position tree into a live one, wiring each `step` leaf's `LiveFrame` and preserving every `use-descent` wrapper unchanged. A `fan-out` node is passed through as-is — its `group` doesn't depend on the frame type parameter, and `tick`'s own live loop (not this function) is what advances it, whether it's the tree's root or nested inside a `use-descent`. */
function toLiveTree(
  tree: CursorTree,
  runtime: Runtime,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
): CursorTree<LiveFrame> {
  if (tree.kind === "step")
    return { kind: "step", frame: buildLiveFrame(tree.frame, runtime, getScope, setScope) };
  if (tree.kind === "use-descent")
    return {
      kind: "use-descent",
      outerNode: tree.outerNode,
      inner: toLiveTree(tree.inner, runtime, getScope, setScope),
    };
  return { kind: "fan-out", group: tree.group };
}

/** The node (in the enclosing level's own flow) that a position's innermost `use-descent` wrapper — if any — folds into; `undefined` at the root. Mirrors what `ReplayFrame.useNodeId` used to carry directly on the frame itself. */
function parentOf<TFrame>(path: PathLevel<TFrame>[]): NodeId | undefined {
  const enclosing = path[path.length - 2]?.node;
  return enclosing?.kind === "use-descent" ? enclosing.outerNode : undefined;
}

/** `tick()`'s own `use` node handling: descends a level into the subgraph, seeded with the outer frame's own current input (no core-side seeding logic left — any scope transition the reaching edge's own `run` fn made via `ctx.thread.start`/`fork` already happened before this node was ever entered) — same descent `driveUseNode` builds for `runFlow`, just captured as data instead of an immediate recursive call. */
function advanceTickUseNode(
  node: Extract<NodeKind, { kind: "use" }>,
  frame: LiveFrame,
  currentScope: ScopeId,
  path: PathLevel<LiveFrame>[],
  runtime: Runtime,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
): { scope: ScopeId; tree: CursorTree<LiveFrame> } {
  const tree = rebuildFromPath(path, path.length - 1, {
    kind: "use-descent",
    outerNode: frame.current,
    inner: {
      kind: "step",
      frame: buildLiveFrame(
        { flow: node.subgraph, current: node.subgraph.entry, currentInput: frame.currentInput },
        runtime,
        getScope,
        setScope,
      ),
    },
  });

  return { scope: currentScope, tree };
}

/** `tick()`'s own `forEach` node handling: builds and replays the group's branches, folding to the join (mutating `frame` in place, same as tick()'s own step-folding elsewhere) the instant every branch is done, or handing off to `advanceForEachGroup` for one more branch-step of work otherwise. */
async function advanceTickForEachNode(
  node: Extract<NodeKind, { kind: "forEach" }>,
  frame: LiveFrame,
  currentScope: ScopeId,
  runtime: Runtime,
  execScope: ExecutionScope,
): Promise<{ kind: "folded"; scope: ScopeId } | { kind: "outcome"; outcome: TickOutcome }> {
  const group = buildForEachGroup(node, frame.current, currentScope, frame.currentInput, runtime);
  for (const branch of group.branches) replayForEachBranch(branch, group, runtime);

  if (group.branches.every((branch) => branch.done)) {
    const outputs = group.branches.map((branch) => branch.output);
    const routed = commitRoute(
      runtime,
      currentScope,
      frame.flow.edges,
      frame.current,
      outputs,
      stepIdentity(frame.current),
    );
    frame.current = routed.to;
    frame.currentInput = routed.input;
    return { kind: "folded", scope: routed.scope };
  }

  return { kind: "outcome", outcome: await advanceForEachGroup(group, runtime, execScope) };
}

/**
 * Routes an aborted model call to the nearest declared `onAbort` target,
 * bubbling outward through `use()`-embedding frames. Walks the live position
 * `path` from the innermost frame (whose step just aborted) outward: the first
 * frame whose graph declares `flow.onAbort` wins, and execution jumps to that
 * target on the SAME scope — synthesizing the exact outcome a
 * `context.invalidate(target, { action: "same" })` call would have
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
  currentScope: ScopeId,
  runtime: Runtime,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
): { scope: ScopeId; tree: CursorTree<LiveFrame> } | undefined {
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const owner = path[depth];
    const target = owner?.flow.onAbort;
    if (!owner || target === undefined) continue;
    const outcome = commitInvalidation(
      runtime,
      currentScope,
      { invalidate: target, action: "same" },
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
        },
        runtime,
        getScope,
        setScope,
      ),
    });
    return { scope: outcome.scope, tree };
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
 * (not forked — `use` shares its parent's scope, unlike a fan-out branch).
 * Reaching the subgraph's own `finish` unwraps that level and folds its
 * result into the enclosing one, exactly like `driveUseNode`'s own tail;
 * parking on the subgraph's own `waitFor` reports a cursor whose `parent` is
 * the `use` node's id, mirroring how a fan-out branch's cursor reports the
 * fan-out node as its parent.
 */
export async function tick(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  // No state may survive between separate tick() calls except what's in the
  // log itself — same reconstruct-from-the-log discipline `replayPosition`
  // applies to cursor position (see `replayStateTracker`'s own doc comment).
  const stateTracker = replayStateTracker(runtime.store.events());
  const execScope = new ExecutionScope(stateTracker);
  const position = replayPosition(flow, runtime);

  // No `input` event committed yet: the session has no starting cursor at
  // all — park at the flow's own entry rather than assuming an empty log
  // means "start at flow.entry with no input" (today's old implicit rule).

  if (position.kind === "not-started") {
    return [{ node: flow.entry, status: "parked" }];
  }

  if (position.kind === "fanout") {
    return advanceFanOutGroup(position.group, flow, runtime, execScope);
  }

  let currentScope: ScopeId = position.scope;
  let pendingInputs: unknown[] | undefined = position.pendingInputs;
  let ranStep = false;

  const getScope = (): ScopeId => currentScope;
  const setScope = (next: ScopeId): void => {
    currentScope = next;
  };

  let tree: CursorTree<LiveFrame> = toLiveTree(position.tree, runtime, getScope, setScope);

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
      const outcome = await advanceFanOutGroup(leaf.node.group, leaf.flow, runtime, execScope);
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
      currentScope,
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
        currentScope,
        enclosing.flow.edges,
        useNodeId,
        frame.currentInput,
        stepIdentity(useNodeId),
      );
      currentScope = routed.scope;
      tree = rebuildFromPath(path, path.length - 2, {
        kind: "step",
        frame: buildLiveFrame(
          {
            flow: enclosing.flow,
            current: routed.to,
            currentInput: routed.input,
          },
          runtime,
          getScope,
          setScope,
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
          setScope,
          stateTracker,
        },
        peekingMessageSource(runtime),
      );

      if (outcome.kind === "parked") {
        return [
          { node: frame.current, status: "parked", waitingFor: outcome.waitingFor, ...parent },
        ];
      }

      currentScope = outcome.scope;
      frame.current = outcome.to;
      frame.currentInput = outcome.input;
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
        currentScope,
        path,
        runtime,
        getScope,
        setScope,
      );
      currentScope = advanced.scope;
      tree = advanced.tree;
      continue;
    }

    if (node.kind === "forEach") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];
      const advanced = await advanceTickForEachNode(node, frame, currentScope, runtime, execScope);
      if (advanced.kind === "outcome") return advanced.outcome;
      currentScope = advanced.scope;
      ranStep = true;
      continue;
    }

    if (node.kind !== "step") notImplemented(`tick: node kind "${node.kind}"`);

    if (ranStep) return [{ node: frame.current, status: "active", ...parent }];

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
      const routed = routeAbort(path, currentScope, runtime, getScope, setScope);
      if (routed) {
        currentScope = routed.scope;
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
        // one Promise.all — see advanceFanOutGroup. Reports the freshly-spawned
        // group's own cursors (nothing run yet) and returns immediately —
        // advancing even the first branch has to wait for the NEXT tick() call,
        // preserving tick's one-step-of-work-per-call budget (this step that just
        // ran IS this call's one step; advanceFanOutGroup would spend a second).
        // Works at any depth: the returned branch cursors already carry their own
        // `parent` (the fan-out node id), and a resumed reconstruction of this same
        // group is handled by replayPosition's matching `leaf.node.kind === "fan-out"`
        // branch.
        appendOutput(runtime, currentScope, emit.output, stepIdentity(frame.current, node.label));
        const group: FanOutGroup = buildFanOutGroup(
          branchTargets,
          frame.current,
          frame.flow,
          currentScope,
          emit.output,
        );
        const parentNode = parentOf(path);
        return group.branches.map((branch) => {
          const cursor = branchCursorState(branch, group);
          return parentNode !== undefined && cursor.parent === undefined
            ? { ...cursor, parent: parentNode }
            : cursor;
        });
      }
    }

    const routed = await driveStepEmit(emit, node, frame.current, {
      flow: frame.flow,
      runtime,
      scope: currentScope,
      execScope,
    });
    if (routed.kind === "retry") {
      ranStep = true;
      continue;
    }
    currentScope = routed.scope;
    frame.current = routed.to;
    frame.currentInput = routed.input;
    pendingInputs = routed.pendingInputs;
    ranStep = true;
  }
}

/** Repeats `tick()` until every cursor reports something other than "active" — parked or done. The loop tick()'s own `driveFlow` caller (runtime.ts) drives to exhaust a session's currently-available work before parking on the store's next event. */
export async function tickUntilSuspended(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  for (;;) {
    const outcome = await tick(flow, runtime);
    if (outcome.every((cursor) => cursor.status !== "active")) return outcome;
  }
}
