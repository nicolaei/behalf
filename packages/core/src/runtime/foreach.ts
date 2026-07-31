// forEach machinery: a dynamic, runtime-sized fan-out whose branch count and
// shape aren't known until the node actually runs (see `driveForEachNode` in
// drive.ts for the runFlow-based counterpart this mirrors). Unlike a static
// fan-out — whose branches are linear `.then()` chains living inside the
// SAME flow, with stable node ids `replayPosition` can match directly
// against the log — each forEach branch is its own freshly-built `Graph`
// (`node.branch(item)`), a top-level `defineGraph` call of its own. Node ids
// are deterministic per build these days (see flow/graph.ts's
// `nodeIdSequence`), so a rebuilt branch actually reuses the same numbers —
// but they're numbers from the branch graph's OWN restarted sequence, shared
// by every structurally identical sibling branch and liable to coincide with
// the main graph's own ids. Matching branch progress by stepId, the way
// `fan-out.ts` does, is thus unavailable here — by design, not by accident.
//
// This is resolved by never needing stepId equality at all: each branch gets
// a deterministic scope id (derived from the forEach node's own stable id,
// its item index, and — critically — how many times this SAME node has
// already fully completed on this scope before this invocation; see
// `forEachBranchScopeId`'s own doc comment for why the invocation count is
// required), and a branch's position is reconstructed by replaying, in
// commit order, only the events tagged with that scope id, folding each one
// into a locally-tracked `current` — never comparing the event's own stepId
// against anything. This works because a scope id, once minted, is a plain
// string persisted in the log itself; it doesn't depend on which process (or
// which call) reconstructs it. The same scope ids are what keep branch
// events out of the main line's own replay: `replayPosition` skips any
// output event committed on a non-main scope while parked at a forEach
// node, precisely because a branch node's id can no longer be relied on to
// miss the main graph's id set (see tick.ts's replay loop).

import type { Graph, NodeId, NodeKind } from "../graph/graph.js";
import type { ScopeId } from "../graph/thread.js";
import type { WaitForResult } from "../graph/step.js";
import type { CommittedEnvelope } from "../session/envelope.js";
import type { Runtime } from "./runtime.js";
import { notImplemented, unreachable } from "./errors.js";
import { route } from "./routing.js";
import { type ExecutionContext, ExecutionScope } from "./step-runner.js";
import { runBranchNode, branchCursorStateWith, findSingleThenEdge } from "./fan-out.js";
import type { CursorState, TickOutcome } from "./tick.js";

/** One forEach branch's reconstructed progress — mirrors `BranchReplay` (fan-out.ts), but `graph` is rebuilt fresh every call (see this file's own doc comment) and `current`/`scope` are reconstructed by replaying only this branch's own deterministic scope, never by matching stepIds. `scope` is set the first time the branch is touched (forked off the group's `mainScope`, same fork semantics as a static fan-out branch — just onto a deterministic id instead of a fresh one). Once `done`, `current` names the branch graph's own `finish` node and `output` holds what reached it. */
export interface ForEachBranchReplay {
  readonly item: unknown;
  readonly index: number;
  readonly scopeId: ScopeId;
  readonly graph: Graph;
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
    if (envelope.stepId !== forEachNodeId) continue;
    if (envelope.threadId !== scope) continue;
    count += 1;
  }
  return count;
}

/**
 * The deterministic scope id every reconstruction of branch `index` agrees
 * on — derived from the forEach node's own stable id, the branch's position
 * in `node.items`' own returned order (both assumed stable/deterministic —
 * the same assumption `driveForEachNode` already makes for runFlow), AND
 * which pass through this node this is (`invocation`, from
 * `completedForEachInvocations`). The node id and item index alone are NOT
 * enough: `agentTurn`-shaped graphs loop back through the very same static
 * forEach node on a later turn, on the SAME scope — without the invocation
 * number, that later pass's branch 0 would derive the identical scope id an
 * earlier, already-completed pass's branch 0 used, and replay would walk
 * straight into that earlier pass's stale committed output instead of
 * running this pass's own tool wait. Folding `invocation` in keeps every
 * pass's branch scope ids distinct, while still being plain, log-derivable
 * strings — nothing here is per-process or per-call state.
 */
function forEachBranchScopeId(forEachNodeId: NodeId, invocation: number, index: number): ScopeId {
  return `${forEachNodeId}::forEach-invocation-${String(invocation)}::forEach-branch-${String(index)}` as ScopeId;
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
      scopeId: forEachBranchScopeId(forEachNodeId, invocation, index),
      graph,
      current: graph.entry,
      currentInput: item,
      done: false,
    };
  });
  return { forEachNodeId, mainScope, branches };
}

/**
 * Reconstructs one branch's position purely from `runtime.store`. A
 * non-message `waitFor` (e.g. `toolCall`) isn't tied to any one event on
 * this branch's own scope — its own Waitable scans the whole committed
 * log — so it's checked, and advanced past, on every settle attempt rather
 * than folded from the per-scope event list; everything else (a `step`'s
 * own output, a message-based `waitFor`) consumes the next not-yet-applied
 * event tagged with this branch's deterministic scope id, in commit order
 * — unambiguously its own, since that scope id belongs to no one else.
 * Interleaving the two (rather than folding scope-scoped events first and
 * checking `match()` only once at the end) matters once more than one node
 * has run: a `waitFor` reached mid-branch must be tried immediately, or
 * events logged for the *next* node would be scanned against the wrong
 * `current` and silently skipped. `use` or a nested forEach/fan-out inside
 * a branch are out of scope for this slice, same as `runBranchNode`'s own
 * limits.
 */
export function replayForEachBranch(
  branch: ForEachBranchReplay,
  _group: ForEachGroup,
  runtime: Runtime,
): void {
  const events: CommittedEnvelope[] = [];
  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;
    if (envelope.threadId !== branch.scopeId) continue;
    events.push(envelope);
  }
  let scope: ScopeId = branch.scope ?? branch.scopeId;
  let index = 0;

  for (;;) {
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

    notImplemented(`forEach branch node kind "${node.kind}"`);
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

  // Every branch in this call descends into the caller's own scope (see
  // ExecutionScope's own doc comment) rather than forking: forEach branches
  // run on the group's own scope ids, but two branches declaring the same
  // `state` -- or a branch and the enclosing scope itself -- must still
  // dedupe into one `stateChange`, exactly as `driveForEachNode`'s own
  // branches do on the non-tick drive path (see drive.ts's
  // `driveForEachNode`, whose doc comment explains why). `descend()` always
  // returns the SAME `stateTracker` instance, so this is one shared tracker
  // across every branch this call touches, not one per branch.

  for (const branch of notDone) {
    const scope: ScopeId = branch.scope ?? branch.scopeId;
    branch.scope = scope;
    const ctx: ExecutionContext = {
      flow: branch.graph,
      runtime,
      scope,
      execScope: execScope.descend(),
    };
    const result = await runBranchNode(branch.current, branch.currentInput, ctx);
    branch.scope = result.scope;
    if (result.kind === "invalidate") notImplemented("tick: forEach branch invalidate");

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

    if (branch.graph.nodes.get(branch.current)?.kind === "finish") {
      branch.done = true;
      branch.output = branch.currentInput;
    }

    return group.branches.map((candidate) => forEachBranchCursorState(candidate, group));
  }

  // Every not-done branch was peeked this call and found parked.
  return group.branches.map((candidate) => forEachBranchCursorState(candidate, group));
}
