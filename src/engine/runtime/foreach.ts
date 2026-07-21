// forEach machinery: a dynamic, runtime-sized fan-out whose branch count and
// shape aren't known until the node actually runs (see `driveForEachNode` in
// drive.ts for the runFlow-based counterpart this mirrors). Unlike a static
// fan-out — whose branches are linear `.then()` chains living inside the
// SAME flow, with stable node ids `replayPosition` can match directly
// against the log — each forEach branch is its own freshly-built `Graph`
// (`node.branch(item)`), and `defineGraph` hands out globally fresh node ids
// on every call. Calling `node.branch(item)` again on a later `tick()` call
// (a fresh Runtime, replaying from scratch) therefore produces a
// *structurally* identical but *numerically* different graph — its node ids
// never match what an earlier call logged. Matching branch progress by
// stepId, the way `fan-out.ts` does, is thus unavailable here.
//
// This is resolved by never needing stepId equality at all: each branch gets
// a deterministic thread id (derived from the forEach node's own stable id
// plus its item index — both constant across every replay), and a branch's
// position is reconstructed by replaying, in commit order, only the events
// tagged with that thread id, folding each one into a locally-tracked
// `current` — never comparing the event's own stepId against anything. This
// works because a thread id, once minted, is a plain string persisted in the
// log itself; unlike a fresh graph's node ids, it doesn't depend on which
// process (or which call) reconstructs it.

import type { Graph, NodeId, NodeKind } from "../../flow/graph.js";
import type { ThreadId } from "../../flow/thread.js";
import type { MessageKind } from "../../flow/message.js";
import type { WaitForResult } from "../../flow/step.js";
import type { Event } from "../../session/event.js";
import type { CommittedEnvelope } from "../../session/envelope.js";
import type { Runtime } from "../runtime.js";
import { notImplemented, unreachable } from "../errors.js";
import { type Thread, withMessage, route } from "./routing.js";
import { tryMessageKindOf } from "../../flow/waitable.js";
import type { ExecutionContext } from "./step-runner.js";
import {
  runBranchNode,
  replayForkedThread,
  branchCursorStateWith,
  findSingleThenEdge,
} from "./fan-out.js";
import type { CursorState, TickOutcome } from "./tick.js";

/** One forEach branch's reconstructed progress — mirrors `BranchReplay` (fan-out.ts), but `graph` is rebuilt fresh every call (see this file's own doc comment) and `current`/`thread` are reconstructed by replaying only this branch's own deterministic thread, never by matching stepIds. `thread` is set the first time the branch is touched (forked off the group's `mainThread`, same fork semantics as a static fan-out branch — just onto a deterministic id instead of a fresh one). Once `done`, `current` names the branch graph's own `finish` node and `output` holds what reached it. */
export interface ForEachBranchReplay {
  readonly item: unknown;
  readonly index: number;
  readonly threadId: ThreadId;
  readonly graph: Graph;
  thread?: Thread;
  current: NodeId;
  currentInput: unknown;
  done: boolean;
  output?: unknown;
  waitingFor?: MessageKind[];
}

/** A forEach node's branches, rebuilt fresh every call from `node.items`/`node.branch` and reconstructed from `runtime.store` the same deterministic way every time — nothing here survives between calls. */
export interface ForEachGroup {
  forEachNodeId: NodeId;
  mainThread: Thread;
  branches: ForEachBranchReplay[];
}

/** The deterministic thread id every reconstruction of branch `index` agrees on — derived from the forEach node's own stable id (constant across every replay) and the branch's position in `node.items`' own returned order (also assumed stable/deterministic — the same assumption `driveForEachNode` already makes for runFlow). */
function forEachBranchThreadId(forEachNodeId: NodeId, index: number): ThreadId {
  return `${forEachNodeId}::forEach-branch-${String(index)}` as ThreadId;
}

/** Builds a forEach node's group from its own `items`/`branch` functions — recomputed identically on every call (live or replay) from the same `currentInput`, so this never needs to persist anything itself. */
export function buildForEachGroup(
  node: Extract<NodeKind, { kind: "forEach" }>,
  forEachNodeId: NodeId,
  mainThread: Thread,
  currentInput: unknown,
): ForEachGroup {
  const items = node.items(currentInput);
  const branches: ForEachBranchReplay[] = items.map((item, index) => {
    const graph = node.branch(item);
    return {
      item,
      index,
      threadId: forEachBranchThreadId(forEachNodeId, index),
      graph,
      current: graph.entry,
      currentInput: item,
      done: false,
    };
  });
  return { forEachNodeId, mainThread, branches };
}

/**
 * Reconstructs one branch's position purely from `runtime.store`. A
 * non-message `waitFor` (e.g. `toolCall`) isn't tied to any one event on
 * this branch's own thread — its own Waitable scans the whole committed
 * log — so it's checked, and advanced past, on every settle attempt rather
 * than folded from the per-thread event list; everything else (a `step`'s
 * own output, a message-based `waitFor`) consumes the next not-yet-applied
 * event tagged with this branch's deterministic thread id, in commit order
 * — unambiguously its own, since that thread id belongs to no one else.
 * Interleaving the two (rather than folding thread-scoped events first and
 * checking `match()` only once at the end) matters once more than one node
 * has run: a `waitFor` reached mid-branch must be tried immediately, or
 * events logged for the *next* node would be scanned against the wrong
 * `current` and silently skipped. `use` or a nested forEach/fan-out inside
 * a branch are out of scope for this slice, same as `runBranchNode`'s own
 * limits.
 */
export function replayForEachBranch(
  branch: ForEachBranchReplay,
  group: ForEachGroup,
  runtime: Runtime,
): void {
  const events: CommittedEnvelope[] = [];
  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;
    if (envelope.threadId !== branch.threadId) continue;
    events.push(envelope);
  }
  let thread: Thread = branch.thread ?? replayForkedThread(group.mainThread, branch.threadId);
  let index = 0;

  for (;;) {
    const node = branch.graph.nodes.get(branch.current);
    if (!node) unreachable(`forEach branch graph has no node "${branch.current}"`);

    if (node.kind === "finish") {
      branch.thread = thread;
      branch.done = true;
      branch.output = branch.currentInput;
      return;
    }

    if (node.kind === "waitFor" && tryMessageKindOf(node.waitable) === undefined) {
      const matched = node.waitable.match(runtime.store.events());
      if (matched === undefined) {
        branch.thread = thread;
        return;
      }
      const routed = route(
        branch.graph.edges,
        branch.current,
        { ok: true, result: matched } satisfies WaitForResult,
        thread,
        runtime,
      );
      thread = routed.thread;
      branch.current = routed.to;
      branch.currentInput = routed.input;
      continue;
    }

    // A step's own output, or a message-based waitFor's own message —
    // either way, this branch's next not-yet-applied event, in order.
    const envelope = events[index];
    if (!envelope) {
      branch.thread = thread;
      return; // nothing logged yet for this node — this is the frontier
    }

    if (node.kind === "step") {
      index += 1;
      if (envelope.type !== "output") continue; // not this step's own event
      const { value } = envelope.event as Event["output"];
      const routed = route(branch.graph.edges, branch.current, value, thread, runtime);
      thread = routed.thread;
      branch.current = routed.to;
      branch.currentInput = routed.input;
      continue;
    }

    if (node.kind === "waitFor") {
      index += 1;
      if (envelope.type !== "message") continue;
      const { message } = envelope.event as Event["message"];
      thread = withMessage(thread, message);
      const routed = route(
        branch.graph.edges,
        branch.current,
        { ok: true, result: message } satisfies WaitForResult,
        thread,
        runtime,
      );
      thread = routed.thread;
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
  attemptsByNode: Map<NodeId, number>,
): Promise<TickOutcome> {
  const notDone = group.branches.filter((branch) => !branch.done);
  if (notDone.length === 0)
    unreachable("advanceForEachGroup: no unfinished branch in a forEach group");

  for (const branch of notDone) {
    const thread: Thread = branch.thread ?? replayForkedThread(group.mainThread, branch.threadId);
    branch.thread = thread;
    const ctx: ExecutionContext = { flow: branch.graph, runtime, thread, attemptsByNode };
    const result = await runBranchNode(branch.current, branch.currentInput, ctx);
    branch.thread = result.thread;
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
