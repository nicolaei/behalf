// Fan-out machinery: running one branch node, walking a branch's full chain
// to its join (runFlow's own fan-out path), and reconstructing/advancing an
// in-flight fan-out group one branch-step at a time (tick's own path).

import type { Graph, NodeId, EdgeDefinition } from "../../flow/graph.js";
import type { ThreadId } from "../../flow/thread.js";
import type { Message, MessageKind, UserMessage } from "../../flow/message.js";
import { messageKindOf, tryMessageKindOf } from "../../flow/waitable.js";
import type { Emit, StepContext, WaitForResult } from "../../flow/step.js";
import type { Runtime } from "../runtime.js";
import { freshCorrelationId } from "./ids.js";
import { notImplemented, unreachable } from "../errors.js";
import {
  type Thread,
  stepIdentity,
  appendOutput,
  applyThreadAction,
  withMessage,
  route,
} from "./routing.js";
import {
  runStep,
  makeStepContext,
  commitCompaction,
  handleStepError,
  type ExecutionContext,
} from "./step-runner.js";
import { runModelCall, callTool, waitForMessage, waitForSignal } from "./execution.js";
import { driveWaitForMessage, findInterruptNodes } from "./drive.js";
import type { CursorState, TickOutcome } from "./tick.js";

/** What running one fan-out branch to completion settled with — a normal reach of its convergence node, or a nested `invalidate` emit that means the fan-out step itself must be rerun instead of joining. */
export type BranchResult =
  | { kind: "output"; output: unknown }
  | { kind: "invalidate"; emit: Extract<Emit, { invalidate: NodeId }> };

/**
 * Walks each branch's linear .then() chain to find the node where all
 * branches converge. Throws notImplemented if any step inside a branch itself
 * fans out (multiple .then() edges), and throws if the branches never reach
 * a common node.
 */
export function findJoinNode(branchTargets: NodeId[], fanOutNodeId: NodeId, flow: Graph): NodeId {
  // Build the linear chain for each branch starting from its own target.
  const chains: NodeId[][] = branchTargets.map((target) => {
    const chain: NodeId[] = [];
    let cursor: NodeId = target;
    const visited = new Set<NodeId>();
    for (;;) {
      if (visited.has(cursor))
        throw new Error(`fan-out branch from "${fanOutNodeId}" contains a cycle at "${cursor}"`);
      visited.add(cursor);
      chain.push(cursor);
      const conditionalEdges = flow.edges.filter(
        (e) => e.from === cursor && (e.edge === "when" || e.edge === "otherwise"),
      );
      if (conditionalEdges.length > 0)
        notImplemented("fan-out branch step with conditional routing");
      const outgoing = flow.edges.filter((e) => e.from === cursor && e.edge === "then");
      if (outgoing.length === 0) break;
      if (outgoing.length > 1) notImplemented("fan-out branch that itself fans out");
      const nextEdge = outgoing[0];
      if (!nextEdge) unreachable("outgoing[0] absent after length guard");
      cursor = nextEdge.to;
    }
    return chain;
  });

  // Return the first node in chains[0] that appears in every other chain.
  const otherSets = chains.slice(1).map((chain) => new Set(chain));
  for (const node of chains[0] ?? []) {
    if (otherSets.every((set) => set.has(node))) return node;
  }

  throw new Error(`fan-out from "${fanOutNodeId}": branches never converge on a common node`);
}

/**
 * Runs one node inside a fan-out branch: builds its `StepContext`, retries on
 * error via the shared `handleStepError` path, commits a `compact` the same
 * way the main loop does, and logs a plain output. A `waitFor` node is
 * consumed the same way `driveWaitForMessage` handles it everywhere else —
 * folding the message into the branch's own thread and (if armed) running an
 * interrupt — but obtaining the message itself differs by `waitMode`:
 * `"block"` (runBranch/runFlow) waits for one to arrive via the shared
 * `waitForMessage`; `"peek"` (tick's `advanceFanOutGroup`, the default) takes
 * one non-blocking shot at the inbox and reports `{ kind: "parked" }` if
 * nothing is there yet, mirroring how tick's own top-level waitFor handling
 * never blocks. A non-message (e.g. signal-based) `Waitable` on the branch's
 * own `waitFor` node takes the same non-message branch `driveWaitForNode`
 * and tick's own waitFor handling do: `"block"` parks on `waitForSignal`;
 * `"peek"` checks `match()` against the committed log, draining and
 * committing at most one pending signal before re-checking, and reports
 * `{ kind: "parked" }` if still unmatched — never extending to interrupt
 * racing inside a branch, which stays out of scope here just as it did for
 * the top-level non-message waitFor path.
 * notImplemented — out of scope for a branch. Only a plain `step`'s result
 * never follows an edge (that's the caller's job, since `runBranch` walks a
 * whole chain to the join while tick's per-call branch advance stops after
 * one node); a `waitFor`'s result already names the routed next node — its
 * own edge (or an armed interrupt's) — since folding the message and routing
 * off it is one inseparable step, same as everywhere else in the engine.
 */
export async function runBranchNode(
  nodeId: NodeId,
  input: unknown,
  ctx: ExecutionContext,
  waitMode: "block" | "peek" = "peek",
): Promise<
  | { kind: "invalidate"; emit: Extract<Emit, { invalidate: NodeId }>; thread: Thread }
  | { kind: "output"; output: unknown; thread: Thread }
  | { kind: "routed"; thread: Thread; to: NodeId; input: unknown }
  | { kind: "parked"; waitingFor: MessageKind[]; thread: Thread }
> {
  const { flow, runtime } = ctx;
  let thread = ctx.thread;
  const nodeDef = flow.nodes.get(nodeId);
  if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${nodeId}"`);

  const setThread = (next: Thread): void => {
    thread = next;
  };

  const nodeIdentity = stepIdentity(nodeId, nodeDef.kind === "step" ? nodeDef.label : undefined);
  const branchContext: StepContext = makeStepContext({
    getThread: () => thread,
    inputs: [input],
    openStream: (type) =>
      runtime.store.open({
        correlationId: freshCorrelationId(runtime),
        type,
        threadId: thread.id,
        ...nodeIdentity,
      }),
    modelCall: (profile) => runModelCall(profile, branchContext, runtime, nodeIdentity, setThread),
    callTool: (tool, toolInput) => callTool(tool, toolInput, thread.id, runtime, nodeIdentity),
  });

  if (nodeDef.kind === "waitFor") {
    const interrupts = findInterruptNodes(flow);
    const waitKind = tryMessageKindOf(nodeDef.waitable);

    // A non-message (e.g. signal-based) Waitable: no message to fold, so
    // this mirrors driveWaitForNode's own non-message branch (waitForSignal)
    // for "block" mode, and tick's peek-and-drain-one-signal shape for
    // "peek" mode — same scope as Story 2/3, not extending to interrupt
    // racing inside a branch.
    if (waitKind === undefined) {
      if (waitMode === "block") {
        const result = await waitForSignal(runtime.store, nodeDef.waitable);
        const routed = route(
          flow.edges,
          nodeId,
          { ok: true, result } satisfies WaitForResult,
          thread,
          runtime,
        );
        return { kind: "routed", thread: routed.thread, to: routed.to, input: routed.input };
      }

      let matched = nodeDef.waitable.match(runtime.store.events());
      if (matched === undefined) {
        const pending = runtime.store.consume((candidate) => candidate.kind === "signal");
        if (pending?.kind === "signal") {
          runtime.store.append(
            {
              name: pending.name,
              ...(pending.payload !== undefined ? { payload: pending.payload } : {}),
            },
            { type: "signal" },
          );
          matched = nodeDef.waitable.match(runtime.store.events());
        }
      }
      if (matched === undefined)
        return { kind: "parked", waitingFor: [nodeDef.waitable.label], thread };

      const routed = route(
        flow.edges,
        nodeId,
        { ok: true, result: matched } satisfies WaitForResult,
        thread,
        runtime,
      );
      return { kind: "routed", thread: routed.thread, to: routed.to, input: routed.input };
    }

    const kinds = [waitKind, ...interrupts.map((interrupt) => messageKindOf(interrupt.waitable))];
    const message: UserMessage | undefined =
      waitMode === "block"
        ? await waitForMessage(runtime.store, kinds)
        : (() => {
            const entry = runtime.store.consume(
              (candidate) =>
                candidate.kind === "message" &&
                candidate.message.kind !== undefined &&
                kinds.includes(candidate.message.kind),
            );
            return entry?.kind === "message" ? entry.message : undefined;
          })();
    if (!message) return { kind: "parked", waitingFor: kinds, thread };

    const routed = await driveWaitForMessage(
      message,
      nodeId,
      interrupts,
      branchContext,
      flow,
      runtime,
      setThread,
    );
    return { kind: "routed", thread: routed.thread, to: routed.to, input: routed.input };
  }

  if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);

  let stepOutput: unknown = undefined;
  for (;;) {
    const emit = await runStep(nodeDef.run, branchContext);

    if ("invalidate" in emit) return { kind: "invalidate", emit, thread };

    if ("compact" in emit) {
      thread = commitCompaction(runtime, thread, emit.compact, emit.meta);
      break; // stepOutput stays undefined; advance to next node
    }

    if ("error" in emit) {
      await handleStepError(emit, nodeId, ctx);
      continue;
    }

    if (!("output" in emit))
      unreachable(`emit "${Object.keys(emit).join(", ")}" in a fan-out branch`);

    appendOutput(runtime, thread.id, emit.output, nodeIdentity);
    stepOutput = emit.output;
    break;
  }
  return { kind: "output", output: stepOutput, thread };
}

/**
 * Runs one fan-out branch to completion on its own forked thread, walking
 * every step in its linear .then() chain until reaching `joinNodeId`.
 * `callTool`/`compact`/`invalidate`/`error` behave the same as the main loop
 * at every step; `invalidate` bubbles up to the caller instead of being acted
 * on locally (see the fan-out handling in `driveStepEmit`), and errors go
 * through the same retry-or-fail path. `step` and `waitFor` nodes are
 * supported inside a branch — a `waitFor` genuinely blocks this branch (via
 * `runBranchNode`'s `"block"` mode) until a matching message arrives, same
 * as the top-level drive loop's own `waitFor` handling, but scoped to this
 * branch's own forked thread; `use` or a nested fan-out are notImplemented.
 * Each node's own work is delegated to `runBranchNode`, shared with tick's
 * per-call branch advance so both drive the exact same node logic.
 */
export async function runBranch(
  startNode: NodeId,
  input: unknown,
  joinNodeId: NodeId,
  ctx: ExecutionContext,
): Promise<BranchResult> {
  const { flow } = ctx;
  let currentNode = startNode;
  let currentThread = ctx.thread;
  let currentInput = input;

  for (;;) {
    const nodeDef = flow.nodes.get(currentNode);
    if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${currentNode}"`);
    if (nodeDef.kind !== "step" && nodeDef.kind !== "waitFor")
      notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);
    if (nodeDef.kind === "step" && nodeDef.label)
      currentThread = { ...currentThread, label: nodeDef.label };

    const result = await runBranchNode(
      currentNode,
      currentInput,
      { ...ctx, thread: currentThread },
      "block",
    );
    currentThread = result.thread;
    if (result.kind === "invalidate") return result;
    if (result.kind === "parked") unreachable("runBranch: blocking waitFor reported parked");

    if (result.kind === "routed") {
      // driveWaitForMessage already resolved the routed edge (this node's own,
      // or an armed interrupt's) — nothing left to look up.
      if (result.to === joinNodeId) return { kind: "output", output: result.input };
      currentNode = result.to;
      currentInput = result.input;
      continue;
    }

    // Follow the step's single outgoing then edge.
    const thenEdge = flow.edges.find((e) => e.from === currentNode && e.edge === "then");
    if (!thenEdge)
      throw new Error(`fan-out branch step "${currentNode}" has no outgoing then edge`);

    if (thenEdge.to === joinNodeId) return { kind: "output", output: result.output };

    // Advance to the next step in this branch.
    currentNode = thenEdge.to;
    currentInput = result.output;
  }
}

/** Applies a branch step's resolved `then` edge (or an already-resolved `{ from, to }` pair, e.g. a `waitFor`'s routed target): reaching the join marks the branch done, holding its output and settling `current` on the step that just produced it (`from` — the node the caller just ran) so it stays there per `BranchReplay.current`'s own contract ("once done, it stays at the last chain node the branch actually ran"); otherwise advances `current`/`currentInput` to `to`. Shared by `runBranch`'s own loop state, `replayBranchOutput`/`replayBranchMessage`, and `advanceFanOutGroup` — every place a branch's step-to-step edge gets resolved — so all of them settle a branch reaching its join the same way. */
export function applyBranchEdge(
  branch: Pick<BranchReplay, "current" | "currentInput" | "done" | "output">,
  thenEdge: Pick<EdgeDefinition, "to" | "from">,
  joinNodeId: NodeId,
  output: unknown,
): void {
  if (thenEdge.to === joinNodeId) {
    branch.done = true;
    branch.output = output;
    branch.current = thenEdge.from;
  } else {
    branch.current = thenEdge.to;
    branch.currentInput = output;
  }
}

/**
 * One fan-out branch's reconstructed progress inside an in-flight group.
 * `thread` is set once the branch has actually run its first node (forked
 * off the group's `mainThread`, same as `runBranch` forks per branch for
 * `runFlow`) — absent while the branch hasn't been picked yet. `current` is
 * the node this branch will run next; once `done`, it stays at the last
 * chain node the branch actually ran, and `output` holds what it reported
 * to the join. `waitingFor` is set only while this branch is parked at its
 * own `waitFor` node with nothing in the inbox yet — the same shape
 * `CursorState.waitingFor` carries for the root and use-descent cases —
 * and cleared the moment a message resolves it.
 */
export interface BranchReplay {
  target: NodeId;
  current: NodeId;
  thread?: Thread;
  currentInput: unknown;
  started: boolean;
  done: boolean;
  output?: unknown;
  waitingFor?: MessageKind[];
}

/**
 * A fan-out node's branches, forked off `mainThread` and walked one node at
 * a time across separate `tick()` calls — reconstructed from
 * `runtime.store` the same way a single cursor's `ReplayPosition` is, just
 * with one `BranchReplay` per branch instead of one `current`/`thread` pair.
 */
export interface FanOutGroup {
  fanOutNodeId: NodeId;
  joinNodeId: NodeId;
  mainThread: Thread;
  branches: BranchReplay[];
}

/** Builds a fan-out group from the branches a fan-out step's `then` edges reach: resolves their common join node and seeds one `BranchReplay` per branch, all starting at their own target with the step's output as their first input. Shared by `replayPosition`'s reconstruction of an in-flight fan-out and `tick`'s own live fan-out path, which both build the exact same group when a step's output turns out to fan out. */
export function buildFanOutGroup(
  branchTargets: NodeId[],
  fanOutNodeId: NodeId,
  flow: Graph,
  mainThread: Thread,
  initialInput: unknown,
): FanOutGroup {
  return {
    fanOutNodeId,
    joinNodeId: findJoinNode(branchTargets, fanOutNodeId, flow),
    mainThread,
    branches: branchTargets.map((target) => ({
      target,
      current: target,
      currentInput: initialInput,
      started: false,
      done: false,
    })),
  };
}

/** A fan-out group's branches all reporting collapses cursor-tracking back to one line: the join node, fed every branch's output in declared order. `undefined` while any branch is still in flight. */
export function foldGroup(
  group: FanOutGroup,
): { current: NodeId; pendingInputs: unknown[] } | undefined {
  if (!group.branches.every((branch) => branch.done)) return undefined;
  return {
    current: group.joinNodeId,
    pendingInputs: group.branches.map((branch) => branch.output),
  };
}

/** Reconstructs a forked branch thread from its observed thread id — an approximation of `applyThreadAction(mainThread, "fork", ...)` sufficient for a branch: a branch CAN fold a further message into its own thread now (via a `waitFor` node, same as `driveWaitForMessage` everywhere else), but that fold is replayed onto the reconstructed thread separately, by `replayBranchMessage` (`withMessage`) — this function only ever needs to approximate the fork point itself, not any fold that happened after it. */
export function replayForkedThread(mainThread: Thread, threadId: ThreadId): Thread {
  return {
    id: threadId,
    forkedFrom: { thread: mainThread.id, at: mainThread.history.length },
    messages: [...mainThread.messages],
    history: [...mainThread.history],
  };
}

/** Folds one committed output event into whichever branch of `group` it belongs to — identified by the event's thread id once known, or by its stepId matching a not-yet-started branch's own target the first time that branch's thread appears in the log. */
export function replayBranchOutput(
  group: FanOutGroup,
  threadId: ThreadId | undefined,
  stepId: NodeId,
  value: unknown,
  flow: Graph,
): void {
  let branch = threadId
    ? group.branches.find((candidate) => candidate.thread?.id === threadId)
    : undefined;
  if (!branch) {
    branch = group.branches.find((candidate) => candidate.target === stepId && !candidate.started);
    if (!branch) return; // not a node this fan-out group owns
    branch.started = true;
    if (threadId) branch.thread = replayForkedThread(group.mainThread, threadId);
  }

  const thenEdge = flow.edges.find((edge) => edge.from === stepId && edge.edge === "then");
  if (!thenEdge) throw new Error(`fan-out branch step "${stepId}" has no outgoing then edge`);

  applyBranchEdge(branch, thenEdge, group.joinNodeId, value);
}

/** Folds one committed message event into whichever branch of `group` it belongs to — mirrors `replayBranchOutput`, but a `waitFor` node's own consumed message carries no `stepId` of its own (unlike a step's output event), so first touch for such a branch is instead recognized as the earliest not-yet-touched one: tick's one-branch-at-a-time model guarantees at most one branch is ever mid-flight, so an unrecognized thread id can only belong to it. Doesn't check whether the message would have armed an interrupt instead of this waitFor's own edge — the top-level single-line replay (`replayPosition`'s own `message`/`waitFor` handling) makes the same simplification, so this stays at parity rather than adding a capability replay doesn't have anywhere else yet. */
export function replayBranchMessage(
  group: FanOutGroup,
  threadId: ThreadId | undefined,
  message: Message,
  flow: Graph,
): void {
  let branch = threadId
    ? group.branches.find((candidate) => candidate.thread?.id === threadId)
    : undefined;
  if (!branch) {
    branch = group.branches.find((candidate) => !candidate.done && !candidate.started);
    if (!branch) return; // not a node this fan-out group owns
    branch.started = true;
    if (threadId) branch.thread = replayForkedThread(group.mainThread, threadId);
  }
  branch.thread = withMessage(branch.thread ?? group.mainThread, message);
  delete branch.waitingFor;

  const waitNodeId = branch.current;
  const thenEdge = flow.edges.find((edge) => edge.from === waitNodeId && edge.edge === "then");
  if (!thenEdge) throw new Error(`fan-out branch step "${waitNodeId}" has no outgoing then edge`);

  applyBranchEdge(branch, thenEdge, group.joinNodeId, {
    ok: true,
    result: message,
  } satisfies WaitForResult);
}

/** One branch cursor's outward `CursorState` — `parked` (not `done`, reserved for the root) once it has folded its own output in or is waiting on its own `waitFor` (with `waitingFor` set, mirroring the root/use-descent cases), `active` while it still has work of its own left. */
export function branchCursorState(branch: BranchReplay, group: FanOutGroup): CursorState {
  if (branch.waitingFor) {
    return {
      node: branch.current,
      status: "parked",
      waitingFor: branch.waitingFor,
      parent: group.fanOutNodeId,
    };
  }
  return {
    node: branch.current,
    status: branch.done ? "parked" : "active",
    parent: group.fanOutNodeId,
  };
}

/**
 * Advances a fan-out group by exactly one node of real work — tick's
 * per-call granularity applied to `runBranchNode` instead of `runBranch`'s
 * run-to-completion loop. Tries each not-yet-done branch in the group's
 * declared order (plain sequential loop, not round-robin): a peek at a
 * branch parked on its own `waitFor` that still finds nothing is a no-op
 * (nothing committed to the log, since `runBranchNode`'s `"peek"` mode
 * never blocks), so this keeps trying the NEXT not-done branch in the same
 * call instead of stopping there — a branch declared before an active
 * sibling (e.g. `start.then([wait, a])`) must not starve that sibling
 * forever. This has to happen within a single call, not by remembering
 * which branch was parked last time: `FanOutGroup` is rebuilt from scratch
 * on every `tick()` call (see `replayPosition`), so a `BranchReplay`'s own
 * `waitingFor` never survives between calls — only what actually got
 * committed to `runtime.store` does. The loop stops the moment a branch
 * does real work (consumes a message, runs a step) and returns right away,
 * preserving tick's one-step-of-work-per-call budget; only once EVERY
 * not-done branch has been peeked and found parked this call does it
 * return the whole group as parked. In the ordinary case (the very first
 * not-done branch can make progress) this behaves exactly like the old
 * `Array.find`-and-stop code: one iteration, one branch touched, same
 * order as always.
 *
 * Forks the branch's own thread off the group's `mainThread` the first
 * time it's picked, same as `runBranch` forks per branch. Once every
 * branch has reported, cursor-tracking collapses: the caller sees a single
 * active cursor at the join node, exactly as if replay had found the fold
 * already in the log.
 *
 * A branch parked at its own `waitFor` (`runBranchNode`'s default `"peek"`
 * mode finding nothing in the inbox) reports back via `waitingFor` on its
 * `BranchReplay` — the same shape a parked root or use-descent cursor
 * already carries — purely for this call's own `CursorState` output; the
 * next call reconstructs the group from scratch and tries again.
 */
export async function advanceFanOutGroup(
  group: FanOutGroup,
  flow: Graph,
  runtime: Runtime,
  attemptsByNode: Map<NodeId, number>,
): Promise<TickOutcome> {
  const notDone = group.branches.filter((candidate) => !candidate.done);
  if (notDone.length === 0)
    unreachable("advanceFanOutGroup: no unfinished branch in a fan-out group");

  for (const branch of notDone) {
    branch.thread ??= applyThreadAction(group.mainThread, "fork", undefined, runtime);
    let branchThread = branch.thread;
    const nodeDef = flow.nodes.get(branch.current);
    if (nodeDef?.kind === "step" && nodeDef.label)
      branchThread = { ...branchThread, label: nodeDef.label };
    branch.thread = branchThread;

    const result = await runBranchNode(branch.current, branch.currentInput, {
      flow,
      runtime,
      thread: branchThread,
      attemptsByNode,
    });
    branch.thread = result.thread;
    if (result.kind === "invalidate") notImplemented("tick: fan-out branch invalidate");

    if (result.kind === "parked") {
      branch.waitingFor = result.waitingFor;
      continue; // this branch has nothing to do yet; try the next one
    }
    delete branch.waitingFor;

    if (result.kind === "routed") {
      // driveWaitForMessage already resolved the routed edge — nothing left to look up.
      applyBranchEdge(
        branch,
        { from: branch.current, to: result.to },
        group.joinNodeId,
        result.input,
      );
    } else {
      const thenEdge = flow.edges.find(
        (edge) => edge.from === branch.current && edge.edge === "then",
      );
      if (!thenEdge)
        throw new Error(`fan-out branch step "${branch.current}" has no outgoing then edge`);
      applyBranchEdge(branch, thenEdge, group.joinNodeId, result.output);
    }

    const folded = foldGroup(group);
    if (folded) return [{ node: folded.current, status: "active" }];
    return group.branches.map((candidate) => branchCursorState(candidate, group));
  }

  // Every not-done branch was peeked this call and found parked.
  return group.branches.map((candidate) => branchCursorState(candidate, group));
}
