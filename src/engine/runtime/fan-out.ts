// Fan-out machinery: running one branch node, walking a branch's full chain
// to its join (runFlow's own fan-out path), and reconstructing/advancing an
// in-flight fan-out group one branch-step at a time (tick's own path).

import type { Graph, NodeId, EdgeDefinition } from "../../flow/graph.js";
import type { ThreadId } from "../../flow/thread.js";
import type { Emit, StepContext } from "../../flow/step.js";
import type { Runtime } from "../runtime.js";
import { freshCorrelationId } from "./ids.js";
import { notImplemented, unreachable } from "../errors.js";
import { type Thread, stepIdentity, appendOutput, applyThreadAction } from "./routing.js";
import {
  runStep,
  makeStepContext,
  commitCompaction,
  handleStepError,
  type ExecutionContext,
} from "./step-runner.js";
import { runModelCall, callTool } from "./execution.js";
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
 * way the main loop does, and logs a plain output. Never follows an edge —
 * that's the caller's job, since `runBranch` walks a whole chain to the join
 * while tick's per-call branch advance stops after this one node.
 */
export async function runBranchNode(
  nodeId: NodeId,
  input: unknown,
  ctx: ExecutionContext,
): Promise<
  | { kind: "invalidate"; emit: Extract<Emit, { invalidate: NodeId }>; thread: Thread }
  | { kind: "output"; output: unknown; thread: Thread }
> {
  const { flow, runtime } = ctx;
  let thread = ctx.thread;
  const nodeDef = flow.nodes.get(nodeId);
  if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${nodeId}"`);
  if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);
  const nodeIdentity = stepIdentity(nodeId, nodeDef.label);

  const setThread = (next: Thread): void => {
    thread = next;
  };

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
 * through the same retry-or-fail path. Only `step` nodes are supported inside
 * a branch; `waitFor`, `use`, or a nested fan-out are notImplemented. Each
 * step's own work is delegated to `runBranchNode`, shared with tick's
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
    if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);
    if (nodeDef.label) currentThread = { ...currentThread, label: nodeDef.label };

    const result = await runBranchNode(currentNode, currentInput, {
      ...ctx,
      thread: currentThread,
    });
    currentThread = result.thread;
    if (result.kind === "invalidate") return result;

    // Follow the step's single outgoing then edge.
    const thenEdge = flow.edges.find((e) => e.from === currentNode && e.edge === "then");
    if (!thenEdge)
      throw new Error(`fan-out branch step "${currentNode}" has no outgoing then edge`);

    const branch = {
      current: currentNode,
      currentInput,
      done: false,
      output: undefined as unknown,
    };
    applyBranchEdge(branch, thenEdge, joinNodeId, result.output);
    if (branch.done) return { kind: "output", output: branch.output };

    // Advance to the next step in this branch.
    currentNode = branch.current;
    currentInput = branch.currentInput;
  }
}

/** Applies a branch step's resolved `then` edge: reaching the join marks the branch done, holding its output and settling `current` on the step that just produced it (`thenEdge.from` — the node the caller just ran) so it stays there per `BranchReplay.current`'s own contract ("once done, it stays at the last chain node the branch actually ran"); otherwise advances `current`/`currentInput` to the edge's target. Shared by `runBranch`'s own loop state, `replayBranchOutput`, and `advanceFanOutGroup` — the three places a branch's step-to-step edge gets resolved — so all three settle a branch reaching its join the same way. */
export function applyBranchEdge(
  branch: Pick<BranchReplay, "current" | "currentInput" | "done" | "output">,
  thenEdge: EdgeDefinition,
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
 * to the join.
 */
export interface BranchReplay {
  target: NodeId;
  current: NodeId;
  thread?: Thread;
  currentInput: unknown;
  started: boolean;
  done: boolean;
  output?: unknown;
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

/** Reconstructs a forked branch thread from its observed thread id — an approximation of `applyThreadAction(mainThread, "fork", ...)` sufficient for a branch, which (like `runBranch`) never runs a node that folds a further message into its thread. */
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

/** One branch cursor's outward `CursorState` — `parked` (not `done`, reserved for the root) once it has folded its own output in, `active` while it still has work of its own left. */
export function branchCursorState(branch: BranchReplay, group: FanOutGroup): CursorState {
  return {
    node: branch.current,
    status: branch.done ? "parked" : "active",
    parent: group.fanOutNodeId,
  };
}

/**
 * Advances one not-yet-done branch of a fan-out group by exactly one node —
 * tick's per-call granularity applied to `runBranchNode` instead of
 * `runBranch`'s run-to-completion loop. Forks the branch's own thread off
 * the group's `mainThread` the first time it's picked, same as `runBranch`
 * forks per branch. Once every branch has reported, cursor-tracking
 * collapses: the caller sees a single active cursor at the join node,
 * exactly as if replay had found the fold already in the log. Picks the
 * first not-done branch in the group's declared order (`Array.find`,
 * sequential, not round-robin) — a documented contract observable at
 * tick()'s entrypoint, since it decides which branch each tick() call
 * advances when more than one still has work left.
 */
export async function advanceFanOutGroup(
  group: FanOutGroup,
  flow: Graph,
  runtime: Runtime,
  attemptsByNode: Map<NodeId, number>,
): Promise<TickOutcome> {
  const branch = group.branches.find((candidate) => !candidate.done);
  if (!branch) unreachable("advanceFanOutGroup: no unfinished branch in a fan-out group");

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

  const thenEdge = flow.edges.find((edge) => edge.from === branch.current && edge.edge === "then");
  if (!thenEdge)
    throw new Error(`fan-out branch step "${branch.current}" has no outgoing then edge`);

  applyBranchEdge(branch, thenEdge, group.joinNodeId, result.output);

  const folded = foldGroup(group);
  if (folded) return [{ node: folded.current, status: "active" }];
  return group.branches.map((candidate) => branchCursorState(candidate, group));
}
