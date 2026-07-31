// Fan-out machinery: running one branch node, walking a branch's full chain
// to its join (runFlow's own fan-out path), and reconstructing/advancing an
// in-flight fan-out group one branch-step at a time (tick's own path).

import type { Graph, NodeId, EdgeDefinition } from "../graph/graph.js";
import type { ScopeId } from "../graph/thread.js";
import type { Emit, StepContext, WaitForResult } from "../graph/step.js";
import { isCommittedEnvelope } from "../session/envelope.js";
import type { Runtime } from "./runtime.js";
import { freshCorrelationId, freshScopeId } from "./ids.js";
import { notImplemented, unreachable } from "./errors.js";
import { stepIdentity, appendOutput } from "./routing.js";
import {
  runStep,
  makeStepContext,
  handleStepError,
  type ExecutionContext,
  ExecutionScope,
} from "./step-runner.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): runModelCall/callTool live in ai/; kept as a runtime→ai import per this task's own scoping (see drive.ts's matching note).
import { runModelCall } from "../ai/model-call.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): see runModelCall's import note above; same reasoning for callTool.
import { callTool } from "../ai/tool-executor.js";
import {
  findInterruptNodes,
  runWaitForNode,
  blockingMessageSource,
  peekingMessageSource,
  type MessageSource,
  type WaitContext,
} from "./drive.js";
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

/** Finds a node's single outgoing `then` edge, or throws — the "one linear next step" shape every branch-walking site (runBranch's loop, replayBranchOutput/replayBranchMessage, advanceFanOutGroup, advanceForEachGroup) assumes. `label` customizes the error message's branch-kind prefix (a forEach branch passes its own). */
export function findSingleThenEdge(
  edges: readonly EdgeDefinition[],
  from: NodeId,
  label = "fan-out branch",
): EdgeDefinition {
  const thenEdge = edges.find((edge) => edge.from === from && edge.edge === "then");
  if (!thenEdge) throw new Error(`${label} step "${from}" has no outgoing then edge`);
  return thenEdge;
}

/**
 * Runs one node inside a fan-out branch: builds its `StepContext`, retries on
 * error via the shared `handleStepError` path, commits a `compact` the same
 * way the main loop does, and logs a plain output. A `waitFor` node is driven
 * through `runWaitForNode` — the same shared implementation `driveGraph` and
 * `tick()` both use — picking `blockingMessageSource` for `waitMode: "block"`
 * (runBranch/runFlow) or `peekingMessageSource` for `"peek"` (tick's
 * `advanceFanOutGroup`, the default), so a branch's waitFor behaves exactly
 * like a top-level one under whichever mode is in play, with no separate
 * copy of that logic to keep in sync. `notImplemented` — out of scope for a
 * branch. Only a plain `step`'s result never follows an edge (that's the
 * caller's job, since `runBranch` walks a whole chain to the join while
 * tick's per-call branch advance stops after one node); a `waitFor`'s result
 * already names the routed next node — its own edge (or an armed
 * interrupt's) — since folding the message and routing off it is one
 * inseparable step, same as everywhere else in the engine.
 */
export async function runBranchNode(
  nodeId: NodeId,
  input: unknown,
  ctx: ExecutionContext,
  waitMode: "block" | "peek" = "peek",
): Promise<
  | { kind: "invalidate"; emit: Extract<Emit, { invalidate: NodeId }>; scope: ScopeId }
  | { kind: "output"; output: unknown; scope: ScopeId }
  | { kind: "routed"; scope: ScopeId; to: NodeId; input: unknown }
  | { kind: "parked"; waitingFor: string[]; scope: ScopeId }
> {
  const { flow, runtime, execScope } = ctx;
  const { stateTracker } = execScope;
  let scope = ctx.scope;
  const nodeDef = flow.nodes.get(nodeId);
  if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${nodeId}"`);

  // A state-less node is invisible to the state machine; fires (or not)
  // exactly once per node visit here, mirroring driveGraph's own top-of-loop
  // check — so a branch's retried step re-checks the same already-seen
  // state and stays a no-op.
  stateTracker.maybeEmit(runtime, scope, nodeDef.state, stepIdentity(nodeId, nodeDef.label));

  const setScope = (next: ScopeId): void => {
    scope = next;
  };

  const nodeIdentity = stepIdentity(nodeId, nodeDef.kind === "step" ? nodeDef.label : undefined);
  const branchContext: StepContext = makeStepContext({
    runtime,
    getScope: () => scope,
    setScope,
    inputs: [input],
    openStream: (type) =>
      runtime.store.open({
        correlationId: freshCorrelationId(runtime),
        type,
        threadId: scope,
        ...nodeIdentity,
      }),
    appendEvent: (payload, type) => {
      runtime.store.append(payload, { type, threadId: scope });
    },
    modelCall: (profile) => runModelCall(profile, branchContext, runtime, setScope),
    callTool: (tool, toolInput) => callTool(tool, toolInput, scope, runtime, nodeIdentity),
    compact: (input) => {
      runtime.store.append(input, { type: "compaction", threadId: scope });
      return Promise.resolve();
    },
    getEvents: () =>
      runtime.store
        .events()
        .filter(isCommittedEnvelope)
        .filter((envelope) => envelope.threadId === scope),
    extensions: runtime.extensions,
  });

  if (nodeDef.kind === "waitFor") {
    const interrupts = findInterruptNodes(flow);
    const source: MessageSource =
      waitMode === "block" ? blockingMessageSource(runtime) : peekingMessageSource(runtime);
    const wait: WaitContext = {
      interrupts,
      context: branchContext,
      flow,
      runtime,
      setScope,
      stateTracker,
    };
    const outcome = await runWaitForNode(nodeDef, nodeId, wait, source);
    if (outcome.kind === "parked") {
      return { kind: "parked", waitingFor: outcome.waitingFor, scope };
    }
    return { kind: "routed", scope: outcome.scope, to: outcome.to, input: outcome.input };
  }

  if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);

  let stepOutput: unknown = undefined;
  for (;;) {
    const emit = await runStep(nodeDef.run, branchContext);

    if ("invalidate" in emit) return { kind: "invalidate", emit, scope };
    if ("error" in emit) {
      await handleStepError(emit, nodeId, ctx);
      continue;
    }

    if (!("output" in emit))
      unreachable(`emit "${Object.keys(emit).join(", ")}" in a fan-out branch`);

    appendOutput(runtime, scope, emit.output, nodeIdentity);
    stepOutput = emit.output;
    break;
  }
  return { kind: "output", output: stepOutput, scope };
}

/**
 * Runs one fan-out branch to completion on its own forked scope, walking
 * every step in its linear .then() chain until reaching `joinNodeId`.
 * `callTool`/`compact`/`invalidate`/`error` behave the same as the main loop
 * at every step; `invalidate` bubbles up to the caller instead of being acted
 * on locally (see the fan-out handling in `driveStepEmit`), and errors go
 * through the same retry-or-fail path. `step` and `waitFor` nodes are
 * supported inside a branch — a `waitFor` genuinely blocks this branch (via
 * `runBranchNode`'s `"block"` mode) until a matching message arrives, same
 * as the top-level drive loop's own `waitFor` handling, but scoped to this
 * branch's own forked scope; `use` or a nested fan-out are notImplemented.
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
  let currentScope = ctx.scope;
  let currentInput = input;

  for (;;) {
    const nodeDef = flow.nodes.get(currentNode);
    if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${currentNode}"`);
    if (nodeDef.kind !== "step" && nodeDef.kind !== "waitFor")
      notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);

    const result = await runBranchNode(
      currentNode,
      currentInput,
      { ...ctx, scope: currentScope },
      "block",
    );
    currentScope = result.scope;
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
    const thenEdge = findSingleThenEdge(flow.edges, currentNode);

    if (thenEdge.to === joinNodeId) return { kind: "output", output: result.output };

    // Advance to the next step in this branch.
    currentNode = thenEdge.to;
    currentInput = result.output;
  }
}

/** Applies a branch step's resolved `then` edge (or an already-resolved `{ from, to }` pair, e.g. a `waitFor`'s routed target): reaching the join marks the branch done, holding its output and settling `current` on the step that just produced it (`from` — the node the caller just ran) so it stays there per `BranchReplay.current`'s own contract ("once done, it stays at the last chain node the branch actually ran"); otherwise advances `current`/`currentInput` to `to`. Shared by `runBranch`'s own loop state, `replayBranchOutput`/`replayBranchMessage`, and `advanceFanOutGroup` — every place a branch's step-to-step edge gets resolved — so all of them settle a branch reaching its join the same way. */
function applyBranchEdge(
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
 * `scope` is set once the branch has actually run its first node (forked
 * off the group's `mainScope`, same as `runBranch` forks per branch for
 * `runFlow`) — absent while the branch hasn't been picked yet. `current` is
 * the node this branch will run next; once `done`, it stays at the last
 * chain node the branch actually ran, and `output` holds what it reported
 * to the join. `waitingFor` is set only while this branch is parked at its
 * own `waitFor` node with nothing in the inbox yet — the same shape
 * `CursorState.waitingFor` carries for the root and use-descent cases —
 * and cleared the moment a message resolves it.
 */
interface BranchReplay {
  target: NodeId;
  current: NodeId;
  scope?: ScopeId;
  currentInput: unknown;
  started: boolean;
  done: boolean;
  output?: unknown;
  waitingFor?: string[];
}

/**
 * A fan-out node's branches, forked off `mainScope` and walked one node at
 * a time across separate `tick()` calls — reconstructed from
 * `runtime.store` the same way a single cursor's `ReplayPosition` is, just
 * with one `BranchReplay` per branch instead of one `current`/`scope` pair.
 */
export interface FanOutGroup {
  fanOutNodeId: NodeId;
  joinNodeId: NodeId;
  mainScope: ScopeId;
  branches: BranchReplay[];
}

/** Builds a fan-out group from the branches a fan-out step's `then` edges reach: resolves their common join node and seeds one `BranchReplay` per branch, all starting at their own target with the step's output as their first input. Shared by `replayPosition`'s reconstruction of an in-flight fan-out and `tick`'s own live fan-out path, which both build the exact same group when a step's output turns out to fan out. */
export function buildFanOutGroup(
  branchTargets: NodeId[],
  fanOutNodeId: NodeId,
  flow: Graph,
  mainScope: ScopeId,
  initialInput: unknown,
): FanOutGroup {
  return {
    fanOutNodeId,
    joinNodeId: findJoinNode(branchTargets, fanOutNodeId, flow),
    mainScope,
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

/** Folds one committed output event into whichever branch of `group` it belongs to — identified by the event's own scope once known, or by its stepId matching a not-yet-started branch's own target the first time that branch's scope appears in the log. */
export function replayBranchOutput(
  group: FanOutGroup,
  scope: ScopeId | undefined,
  stepId: NodeId,
  value: unknown,
  flow: Graph,
): void {
  let branch = scope ? group.branches.find((candidate) => candidate.scope === scope) : undefined;
  if (!branch) {
    branch = group.branches.find((candidate) => candidate.target === stepId && !candidate.started);
    if (!branch) return; // not a node this fan-out group owns
    branch.started = true;
    if (scope) branch.scope = scope;
  }

  const thenEdge = findSingleThenEdge(flow.edges, stepId);

  applyBranchEdge(branch, thenEdge, group.joinNodeId, value);
}

/** Folds one committed message event into whichever branch of `group` it belongs to — mirrors `replayBranchOutput`, but a `waitFor` node's own consumed message carries no `stepId` of its own (unlike a step's output event), so first touch for such a branch is instead recognized as the earliest not-yet-touched one: tick's one-branch-at-a-time model guarantees at most one branch is ever mid-flight, so an unrecognized scope can only belong to it. Doesn't check whether the message would have armed an interrupt instead of this waitFor's own edge — the top-level single-line replay (`replayPosition`'s own `message`/`waitFor` handling) makes the same simplification, so this stays at parity rather than adding a capability replay doesn't have anywhere else yet. Content-folding itself is no longer this function's concern — an extension's own `state()` fold reads it back generically, per scope; this only ever moves the branch's own position. */
export function replayBranchMessage(
  group: FanOutGroup,
  scope: ScopeId | undefined,
  message: unknown,
  flow: Graph,
): void {
  let branch = scope ? group.branches.find((candidate) => candidate.scope === scope) : undefined;
  if (!branch) {
    branch = group.branches.find((candidate) => !candidate.done && !candidate.started);
    if (!branch) return; // not a node this fan-out group owns
    branch.started = true;
    if (scope) branch.scope = scope;
  }
  delete branch.waitingFor;

  const waitNodeId = branch.current;
  const thenEdge = findSingleThenEdge(flow.edges, waitNodeId);

  applyBranchEdge(branch, thenEdge, group.joinNodeId, {
    ok: true,
    result: message,
  } satisfies WaitForResult);
}

/**
 * Folds one committed `signal` event into whichever branch of `group` it
 * resolves — the fan-out-branch counterpart to `replayPosition`'s own
 * top-level `applySignalEvent` handling, which this was missing entirely:
 * without it, a branch parked on a signal-based `waitFor` in peek mode
 * advances in memory on the tick() call that sees the signal arrive, but the
 * NEXT tick() call reconstructs the group fresh from the log with no record
 * of that advance — the drained signal event used to carry no scope
 * attribution at all, so replay had nothing to recognize the branch by —
 * and it re-parks at the same node forever, live progress silently
 * discarded every call.
 *
 * `drainOnePendingSignal` now tags the committed event with the waitFor
 * node's own scope (`runWaitForNode` passes `context.scope`, a fan-
 * out branch's own forked scope), so first touch works exactly like
 * `replayBranchOutput`/`replayBranchMessage`: recognized by `scope` once
 * known, or — the first time this branch's own scope appears — by finding
 * the not-yet-started, not-done branch currently parked at its own
 * non-message `waitFor` node whose `Waitable.match()` actually succeeds
 * against the committed log (the same test `applySignalEvent` and
 * `peekSignalMatch` both use). Checking `match()` rather than trusting "the
 * earliest untouched branch" matters here specifically because a signal
 * carries no kind to multiplex by — unlike a message — so more than one
 * branch could otherwise be parked on a distinct signal at once.
 */
export function replayBranchSignal(
  group: FanOutGroup,
  scope: ScopeId | undefined,
  flow: Graph,
  runtime: Runtime,
): void {
  let branch = scope ? group.branches.find((candidate) => candidate.scope === scope) : undefined;
  if (!branch) {
    branch = group.branches.find((candidate) => {
      if (candidate.done || candidate.started) return false;
      const nodeDef = flow.nodes.get(candidate.current);
      if (nodeDef?.kind !== "waitFor" || tryMessageKindless(nodeDef.waitable) !== undefined)
        return false;
      return nodeDef.waitable.match(runtime.store.events()) !== undefined;
    });
    if (!branch) return; // not a node this fan-out group owns
    branch.started = true;
    if (scope) branch.scope = scope;
  }

  const nodeDef = flow.nodes.get(branch.current);
  if (nodeDef?.kind !== "waitFor" || tryMessageKindless(nodeDef.waitable) !== undefined) return;
  const matched = nodeDef.waitable.match(runtime.store.events());
  if (matched === undefined) return;

  delete branch.waitingFor;
  const thenEdge = findSingleThenEdge(flow.edges, branch.current);
  applyBranchEdge(branch, thenEdge, group.joinNodeId, {
    ok: true,
    result: matched,
  } satisfies WaitForResult);
}

function tryMessageKindless(waitable: { provider: string; label: string }): string | undefined {
  return waitable.provider === "userInput" ? waitable.label : undefined;
}

/** One branch cursor's outward `CursorState` — shared shape for a fan-out branch and a forEach branch (see `forEachBranchCursorState`, foreach.ts): `parked` (not `done`, reserved for the root) once it has folded its own output in or is waiting on its own `waitFor` (with `waitingFor` set, mirroring the root/use-descent cases), `active` while it still has work of its own left. `parentNodeId` names whichever node the caller's branch cursors report as their parent (a fan-out node's or a forEach node's own id). */
export function branchCursorStateWith(
  branch: Pick<BranchReplay, "current" | "done" | "waitingFor">,
  parentNodeId: NodeId,
): CursorState {
  if (branch.waitingFor) {
    return {
      node: branch.current,
      status: "parked",
      waitingFor: branch.waitingFor,
      parent: parentNodeId,
    };
  }
  return {
    node: branch.current,
    status: branch.done ? "parked" : "active",
    parent: parentNodeId,
  };
}

/** A fan-out branch's own `CursorState` — delegates to `branchCursorStateWith` with the group's fan-out node id as parent. */
export function branchCursorState(branch: BranchReplay, group: FanOutGroup): CursorState {
  return branchCursorStateWith(branch, group.fanOutNodeId);
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
 * Forks the branch's own scope off the group's `mainScope` the first
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
  execScope: ExecutionScope,
): Promise<TickOutcome> {
  const notDone = group.branches.filter((candidate) => !candidate.done);
  if (notDone.length === 0)
    unreachable("advanceFanOutGroup: no unfinished branch in a fan-out group");

  for (const branch of notDone) {
    branch.scope ??= freshScopeId(runtime);
    const branchScope = branch.scope;

    const result = await runBranchNode(branch.current, branch.currentInput, {
      flow,
      runtime,
      scope: branchScope,
      // Fresh per branch is correct here, not a stopgap: a fan-out branch
      // forks its own scope (see advanceFanOutGroup's own forking
      // above), so its state tracking is independent of any sibling's,
      // same as driveStepEmit's fan-out handling in drive.ts. attemptsByNode
      // stays shared — fork() never forks it (see ExecutionScope's own doc
      // comment).
      execScope: execScope.fork(),
    });
    branch.scope = result.scope;
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
      const thenEdge = findSingleThenEdge(flow.edges, branch.current);
      applyBranchEdge(branch, thenEdge, group.joinNodeId, result.output);
    }

    const folded = foldGroup(group);
    if (folded) return [{ node: folded.current, status: "active" }];
    return group.branches.map((candidate) => branchCursorState(candidate, group));
  }

  // Every not-done branch was peeked this call and found parked.
  return group.branches.map((candidate) => branchCursorState(candidate, group));
}
