// forEach machinery: a dynamic, runtime-sized fan-out whose branch count and
// shape aren't known until the node actually runs. Unlike a static fan-out —
// whose branches are linear `.then()` chains living inside the SAME flow, with
// stable node ids `replayPosition` can match directly against the log — each
// forEach branch is its own freshly-built `Graph` (`node.branch(item)`), a
// top-level `defineGraph` call of its own. Node ids are deterministic per build
// these days (see flow/graph.ts's `nodeIdSequence`), so a rebuilt branch
// actually reuses the same numbers — but they're numbers from the branch
// graph's OWN restarted sequence, shared by every structurally identical
// sibling branch and liable to coincide with the main graph's own ids. Matching
// branch progress by stepId, the way `fan-out.ts` does, is thus unavailable
// here — by design, not by accident.
//
// It's resolved instead by a dedicated attribution axis on the envelope: each
// branch gets a deterministic `branchId` (derived from the forEach node's own
// stable id, its item index, and — critically — how many times this SAME node
// has already fully completed on this scope; see `forEachBranchId`'s own doc
// comment for why the invocation count is required), every event it commits is
// tagged with it, and a branch's position is reconstructed by replaying, in
// commit order, only the events carrying that key.
//
// The branch's SCOPE stays the enclosing flow's own, unforked — that's the
// documented forEach semantic: a branch's steps read the same thread, and two
// branches declaring the same `state` dedupe into one `stateChange`. Keeping
// attribution off the scope is what makes both possible at once. `tick()` also
// advances at most one branch per call, so siblings never actually run
// concurrently on that shared scope.

import type { Graph, NodeId, NodeKind } from "../graph/graph.js";
import type { ScopeId } from "../graph/thread.js";
import type { WaitForResult } from "../graph/step.js";
import type { CommittedEnvelope } from "../session/envelope.js";
import type { Runtime } from "./runtime.js";
import { unreachable } from "./errors.js";
import { commitInvalidation } from "./drive.js";
import { route } from "./routing.js";
import { type ExecutionContext, ExecutionScope } from "./step-runner.js";
import { runBranchNode, branchCursorStateWith, findSingleThenEdge } from "./fan-out.js";
import type { CursorState, TickOutcome } from "./tick.js";

/** One forEach branch's reconstructed progress — mirrors `BranchReplay` (fan-out.ts), but `graph` is rebuilt fresh every call (see this file's own doc comment) and `current` is reconstructed by replaying only the events carrying this branch's own deterministic `branchId`, never by matching stepIds. The branch runs on the group's `mainScope`, unforked; `scope` tracks where it has moved to if one of its own steps performed a scope transition. Once `done`, `current` names the branch graph's own `finish` node and `output` holds what reached it. */
export interface ForEachBranchReplay {
  readonly item: unknown;
  readonly index: number;
  readonly branchId: string;
  /** The graph this branch is currently positioned in — its own, or a `use` subgraph it has descended into. */
  graph: Graph;
  /** Enclosing `use` frames, innermost last. Rebuilt from scratch by `settleBranchPosition` on every reconstruction; nothing here is persisted. */
  stack: { graph: Graph; node: NodeId }[];
  scope?: ScopeId;
  current: NodeId;
  currentInput: unknown;
  done: boolean;
  output?: unknown;
  waitingFor?: string[];
}

/** A forEach node's branches, rebuilt fresh every call from `node.items`/`node.branch` and reconstructed from `runtime.store` the same deterministic way every time — nothing here survives between calls. */
export interface ForEachGroup {
  forEachNodeId: NodeId;
  mainScope: ScopeId;
  branches: ForEachBranchReplay[];
}

/**
 * How many times this forEach node has already fully completed (folded
 * back to its join edge) on this scope, BEFORE this invocation —
 * reconstructed purely from the log, the same discipline `replayStateTracker`
 * applies elsewhere: every completed invocation logs exactly one "output"
 * event tagged with the forEach node's own stepId and the scope it folded
 * on (see `commitRoute`'s call in `advanceTickForEachNode`), so counting
 * those gives an invocation number that agrees across every replay.
 */
function completedForEachInvocations(
  runtime: Runtime,
  forEachNodeId: NodeId,
  scope: ScopeId,
): number {
  let count = 0;
  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;
    if (envelope.type !== "output") continue;
    // A branch runs on the same scope as the fold, and a rebuilt branch
    // graph's node ids restart from the same sequence — so a branch step's own
    // id really can equal this forEach node's. `branchId` is what tells them
    // apart; without this guard a branch's output inflates the invocation
    // count, every branch key shifts, and replay loses branches it already ran.
    if (envelope.branchId !== undefined) continue;
    if (envelope.stepId !== forEachNodeId) continue;
    if (envelope.threadId !== scope) continue;
    count += 1;
  }
  return count;
}

/**
 * The deterministic `branchId` every reconstruction of branch `index` agrees
 * on — derived from the forEach node's own stable id, the branch's position in
 * `node.items`' own returned order (assumed stable/deterministic), AND which
 * pass through this node this is (`invocation`, from
 * `completedForEachInvocations`). The node id and item index alone are NOT
 * enough: `agentTurn`-shaped graphs loop back through the very same static
 * forEach node on a later turn — without the invocation number, that later
 * pass's branch 0 would derive the identical key an earlier, already-completed
 * pass's branch 0 used, and replay would walk straight into that earlier
 * pass's stale committed output instead of running this pass's own tool wait.
 * Folding `invocation` in keeps every pass's branch keys distinct, while still
 * being plain, log-derivable strings — nothing here is per-process or per-call
 * state.
 */
function forEachBranchId(forEachNodeId: NodeId, invocation: number, index: number): string {
  return `${forEachNodeId}::forEach-invocation-${String(invocation)}::forEach-branch-${String(index)}`;
}

/** Builds a forEach node's group from its own `items`/`branch` functions — recomputed identically on every call (live or replay) from the same `currentInput`, so this never needs to persist anything itself beyond what `completedForEachInvocations` reads back out of the log. */
export function buildForEachGroup(
  node: Extract<NodeKind, { kind: "forEach" }>,
  forEachNodeId: NodeId,
  mainScope: ScopeId,
  currentInput: unknown,
  runtime: Runtime,
): ForEachGroup {
  const invocation = completedForEachInvocations(runtime, forEachNodeId, mainScope);
  const items = node.items(currentInput);
  const branches: ForEachBranchReplay[] = items.map((item, index) => {
    const graph = node.branch(item);
    return {
      item,
      index,
      branchId: forEachBranchId(forEachNodeId, invocation, index),
      graph,
      stack: [],
      current: graph.entry,
      currentInput: item,
      done: false,
    };
  });
  return { forEachNodeId, mainScope, branches };
}

/**
 * Settles a branch's position onto a node that can actually do work — a
 * `step`, a `waitFor`, or the branch's own outermost `finish`.
 *
 * A `use` node inside a branch is pure structure: entering its subgraph and
 * folding the subgraph's terminal value back out again are both decided
 * entirely by the branch's own position, with nothing to look up in the log.
 * So neither costs an event, and both replay and the live advance derive them
 * the same way by calling this — which is exactly why a branch can contain a
 * `use` at all. (A top-level `use` DOES commit a fold event, because there the
 * enclosing position is reconstructed by matching stepIds against the log; a
 * branch reconstructs its position from its own walk instead.)
 *
 * Loops, so a subgraph whose entry is itself a `use`, or a subgraph that
 * finishes straight into another one, settles in a single call.
 */
function settleBranchPosition(branch: ForEachBranchReplay): void {
  for (;;) {
    const node = branch.graph.nodes.get(branch.current);
    if (!node) unreachable(`forEach branch graph has no node "${branch.current}"`);

    if (node.kind === "use") {
      branch.stack.push({ graph: branch.graph, node: branch.current });
      branch.graph = node.subgraph;
      branch.current = node.subgraph.entry;
      continue;
    }

    if (node.kind === "finish" && branch.stack.length > 0) {
      const frame = branch.stack.pop();
      if (!frame) unreachable("settleBranchPosition: stack emptied between check and pop");
      const thenEdge = findSingleThenEdge(frame.graph.edges, frame.node, "forEach branch");
      branch.graph = frame.graph;
      branch.current = thenEdge.to;
      continue;
    }

    return;
  }
}

/**
 * Reconstructs one branch's position purely from `runtime.store`. A
 * non-message `waitFor` (e.g. `toolCall`) isn't tied to any one event on this
 * branch — its own Waitable scans the whole committed log — so it's checked,
 * and advanced past, on every settle attempt rather than folded from the
 * per-branch event list; everything else (a `step`'s own output, a
 * message-based `waitFor`) consumes the next not-yet-applied event carrying
 * this branch's own `branchId`, in commit order — unambiguously its own, since
 * that key belongs to no one else. Interleaving the two (rather than folding
 * branch events first and checking `match()` only once at the end) matters
 * once more than one node has run: a `waitFor` reached mid-branch must be
 * tried immediately, or events logged for the *next* node would be scanned
 * against the wrong `current` and silently skipped. `use` descents are settled
 * structurally by `settleBranchPosition`; a nested forEach/fan-out inside a
 * branch is still out of scope, same as `runBranchNode`'s own limits.
 */
export function replayForEachBranch(
  branch: ForEachBranchReplay,
  group: ForEachGroup,
  runtime: Runtime,
): void {
  const events: CommittedEnvelope[] = [];
  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;
    if (envelope.branchId !== branch.branchId) continue;
    events.push(envelope);
  }
  let scope: ScopeId = group.mainScope;
  let index = 0;

  for (;;) {
    settleBranchPosition(branch);
    const node = branch.graph.nodes.get(branch.current);
    if (!node) unreachable(`forEach branch graph has no node "${branch.current}"`);

    if (node.kind === "finish") {
      branch.scope = scope;
      branch.done = true;
      branch.output = branch.currentInput;
      return;
    }

    if (node.kind === "waitFor" && node.waitable.provider !== "userInput") {
      const matched = node.waitable.match(runtime.store.events());
      if (matched === undefined) {
        branch.scope = scope;
        return;
      }
      const routed = route(
        branch.graph.edges,
        branch.current,
        { ok: true, result: matched } satisfies WaitForResult,
        scope,
      );
      scope = routed.scope;
      branch.current = routed.to;
      branch.currentInput = routed.input;
      continue;
    }

    // A step's own output, or a message-based waitFor's own message —
    // either way, this branch's next not-yet-applied event, in order.
    const envelope = events[index];
    if (!envelope) {
      branch.scope = scope;
      return; // nothing logged yet for this node — this is the frontier
    }

    if (node.kind === "step") {
      index += 1;
      if (envelope.type !== "output") continue; // not this step's own event
      const value = (envelope.event as { value: unknown }).value;
      const routed = route(branch.graph.edges, branch.current, value, scope);
      scope = routed.scope;
      branch.current = routed.to;
      branch.currentInput = routed.input;
      continue;
    }

    if (node.kind === "waitFor") {
      index += 1;
      if (envelope.type !== "message") continue;
      const message = (envelope.event as { message: unknown }).message;
      const routed = route(
        branch.graph.edges,
        branch.current,
        { ok: true, result: message } satisfies WaitForResult,
        scope,
      );
      scope = routed.scope;
      branch.current = routed.to;
      branch.currentInput = routed.input;
      continue;
    }

    unreachable(`forEach branch node kind "${node.kind}" survived settleBranchPosition`);
  }
}

/** One forEach branch's outward `CursorState` — delegates to `branchCursorStateWith` (fan-out.ts) with the group's forEach node id as parent. */
export function forEachBranchCursorState(
  branch: ForEachBranchReplay,
  group: ForEachGroup,
): CursorState {
  return branchCursorStateWith(branch, group.forEachNodeId);
}

/**
 * Advances a forEach group by exactly one node of real work, the same
 * per-call budget `advanceFanOutGroup` gives a static fan-out — tries each
 * not-done branch in declared (item) order via the shared `runBranchNode`
 * (peek mode, never blocking), stopping the instant one does real work.
 * Every branch is assumed already reconstructed (via `replayForEachBranch`)
 * before this runs, so it only ever drives — never replays — a branch's own
 * position.
 */
export async function advanceForEachGroup(
  group: ForEachGroup,
  runtime: Runtime,
  execScope: ExecutionScope,
): Promise<TickOutcome> {
  const notDone = group.branches.filter((branch) => !branch.done);
  if (notDone.length === 0)
    unreachable("advanceForEachGroup: no unfinished branch in a forEach group");

  // Every branch descends into the caller's own `ExecutionScope` rather than
  // forking: two branches declaring the same `state` — or a branch and the
  // enclosing scope itself — must dedupe into one `stateChange`, since they
  // genuinely share one scope. `descend()` always returns the SAME
  // `stateTracker` instance, so this is one shared tracker across every branch
  // this call touches, not one per branch.
  for (const branch of notDone) {
    const ctx: ExecutionContext = {
      flow: branch.graph,
      runtime,
      // A forEach branch runs on its PARENT's scope, not a forked one: two
      // branches declaring the same `state` are two nodes on one scope and
      // must dedupe into a single `stateChange`, and a branch's steps read the
      // same thread the enclosing flow does. What separates one branch's
      // events from a sibling's is `branchId`, not the scope.
      scope: group.mainScope,
      execScope: execScope.descend(),
      branchId: branch.branchId,
    };
    const result = await runBranchNode(branch.current, branch.currentInput, ctx);
    branch.scope = result.scope;
    if (result.kind === "invalidate") {
      // Same rule a static fan-out branch's invalidate follows (see
      // `advanceFanOutGroup`): the group is abandoned, the invalidated node
      // reruns on the enclosing line, and the forEach node fans out again from
      // scratch on its next visit.
      const outcome = commitInvalidation(runtime, group.mainScope, result.emit);
      if (outcome.kind !== "advance")
        unreachable("advanceForEachGroup: commitInvalidation must advance");
      return [{ node: outcome.to, status: "active" }];
    }

    if (result.kind === "parked") {
      branch.waitingFor = result.waitingFor;
      continue; // this branch has nothing to do yet; try the next one
    }
    delete branch.waitingFor;

    if (result.kind === "routed") {
      // driveWaitForMessage already resolved the routed edge.
      branch.current = result.to;
      branch.currentInput = result.input;
    } else {
      const thenEdge = findSingleThenEdge(branch.graph.edges, branch.current, "forEach branch");
      branch.current = thenEdge.to;
      branch.currentInput = result.output;
    }

    // Settle past any `use` boundary the new position sits on (entering a
    // subgraph, or folding one back out) before asking whether the branch is
    // finished — the same structural walk replay performs, so both agree.
    settleBranchPosition(branch);
    if (branch.graph.nodes.get(branch.current)?.kind === "finish") {
      branch.done = true;
      branch.output = branch.currentInput;
    }

    return group.branches.map((candidate) => forEachBranchCursorState(candidate, group));
  }

  // Every not-done branch was peeked this call and found parked.
  return group.branches.map((candidate) => forEachBranchCursorState(candidate, group));
}
