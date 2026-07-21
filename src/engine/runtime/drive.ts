// The drive loop: runs a graph node by node from its entry to its `finish`
// node, handling `use`, `waitFor`, invalidate, compact, step errors, and
// fan-out along the way. This is the whole engine loop — shared by the
// top-level runFlow drive and any `use` node's inline subgraph drive — and
// tick()'s own live execution reuses several of its pieces (buildDriveContext,
// findInterruptNodes, driveStepEmit, seedUseNode) to drive one node at a
// time instead of to completion.

import type { Graph, NodeId, NodeKind } from "../../flow/graph.js";
import type { Message, UserMessage } from "../../flow/message.js";
import type { Waitable } from "../../flow/waitable.js";
import { tryMessageKindOf } from "../../flow/waitable.js";
import type { Step, StepContext, Emit, ModelCallResult, WaitForResult } from "../../flow/step.js";
import type { Tool } from "../../flow/tool.js";
import type { Runtime } from "../runtime.js";
import { freshCorrelationId } from "./ids.js";
import { notImplemented, unreachable } from "../errors.js";
import {
  type Thread,
  type StepIdentity,
  type RouteResult,
  stepIdentity,
  appendOutput,
  route,
  commitRoute,
  applyThreadAction,
  withMessage,
  thenEdges,
} from "./routing.js";
import {
  runStep,
  makeStepContext,
  withInputs,
  assertJoinTagging,
  commitCompaction,
  handleStepError,
  type ExecutionContext,
} from "./step-runner.js";
import { runModelCall, callTool, waitForSignal, waitForRace } from "./execution.js";
import { findJoinNode, runBranch, type BranchResult } from "./fan-out.js";

export interface InterruptNode {
  id: NodeId;
  waitable: Waitable<unknown>;
  run: Step;
}

/** Every `interrupt` node in the graph — armed for the whole run, not just one node. */
export function findInterruptNodes(flow: Graph): InterruptNode[] {
  const interrupts: InterruptNode[] = [];
  for (const [id, node] of flow.nodes) {
    if (node.kind === "interrupt") interrupts.push({ id, waitable: node.waitable, run: node.run });
  }
  return interrupts;
}

/** Distinguishes a real `Message` from a plain marker value (e.g. `waitFor`'s `WaitForResult`) reaching a `use` node as its incoming value. */
function looksLikeMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value && "content" in value;
}

/**
 * Computes a `use` node's subgraph seed and folds it into the thread and
 * log: the reaching edge's `prompt` output, if it had one (the previous
 * iteration's `follow` already pushed it onto the thread; logged again here
 * so it lands in the log too), otherwise the raw incoming value if it's a
 * real `Message` (never pushed onto the thread, so push it now — this node
 * is its only source), or — when the incoming value is a non-message marker
 * such as `waitFor`'s `{ ok: true }` — the message that marker stands for,
 * already the thread's last message. Shared by `driveUseNode` (runFlow) and
 * tick()'s own inline `use` handling, which both compute and log a subgraph
 * seed identically; only how each then drives the subgraph differs.
 */
export function seedUseNode(
  reason: Message | undefined,
  currentInput: unknown,
  thread: Thread,
  runtime: Runtime,
): { seed: Message; thread: Thread } {
  const fallback: Message | undefined = thread.messages.at(-1);
  const seed: Message | undefined =
    reason ?? (looksLikeMessage(currentInput) ? currentInput : fallback);
  if (!seed) throw new Error("use node has no message to seed its subgraph with");
  const seededThread = reason ? thread : withMessage(thread, seed);
  runtime.store.append({ message: seed }, { type: "message", threadId: seededThread.id });
  return { seed, thread: seededThread };
}

/** Runs a `use` node: seeds its subgraph, drives it inline to its own `finish`, and follows the reaching edge with its result. */
async function driveUseNode(
  node: Extract<NodeKind, { kind: "use" }>,
  nodeId: NodeId,
  reason: Message | undefined,
  currentInput: unknown,
  ctx: ExecutionContext,
): Promise<RouteResult> {
  const { flow, runtime } = ctx;
  const { seed, thread } = seedUseNode(reason, currentInput, ctx.thread, runtime);

  const result = await driveGraph(node.subgraph, runtime, thread, seed);

  return commitRoute(
    runtime,
    result.thread.id,
    flow.edges,
    nodeId,
    result.output,
    stepIdentity(nodeId),
    result.thread,
  );
}

/**
 * Runs a `forEach` node: computes its items from the prior step's output,
 * builds one branch `Graph` per item via `node.branch` (a dynamic, runtime-
 * sized fan-out — unlike a static `.then([a, b])` fan-out, the branch count
 * and shape aren't known until this node actually runs), drives each branch
 * as a first-class subgraph on its own forked thread — the same machinery
 * `driveUseNode` uses for a single `use`d subgraph, just one call per item —
 * and folds every branch's own result back into an array as this node's
 * single output. Branches run concurrently (`Promise.all`), same as a static
 * fan-out's `driveStepEmit` runs its branches.
 */
async function driveForEachNode(
  node: Extract<NodeKind, { kind: "forEach" }>,
  nodeId: NodeId,
  currentInput: unknown,
  ctx: ExecutionContext,
): Promise<RouteResult> {
  const { flow, runtime, thread } = ctx;
  const items = node.items(currentInput);
  const results = await Promise.all(
    items.map((item) => {
      const branchThread = applyThreadAction(thread, "fork", undefined, runtime);
      return driveGraph(node.branch(item), runtime, branchThread, item);
    }),
  );
  const outputs = results.map((result) => result.output);

  return commitRoute(runtime, thread.id, flow.edges, nodeId, outputs, stepIdentity(nodeId), thread);
}

/**
 * Folds a waitFor node's already-obtained message into the thread and
 * routes it: if the message is what an armed `interrupt` was waiting for,
 * that step runs and takes over routing — reading `context.thread` live
 * rather than a local snapshot, so a reply the interrupt's own
 * `context.modelCall()` folds in is never dropped — otherwise this node's
 * own edge is followed. Shared by `driveWaitForNode` (runFlow, which blocks
 * until a message arrives via `waitForMessage`) and tick()'s own waitFor
 * handling (which consumes non-blockingly and parks if none is ready yet):
 * the two differ only in how the message is obtained, never in what
 * happens once it's in hand — this is the single implementation the old
 * TODO(R2) asked for. `ranInterruptStep` reports whether this call actually
 * ran a step (the interrupt) or just consumed a message for free, so
 * tick() can decide whether this counts toward its one-step-per-call budget.
 */
export async function driveWaitForMessage(
  message: UserMessage,
  nodeId: NodeId,
  interrupts: InterruptNode[],
  context: StepContext,
  flow: Graph,
  runtime: Runtime,
  setThread: (thread: Thread) => void,
): Promise<RouteResult & { ranInterruptStep: boolean }> {
  // Consuming the message is the same step regardless of who it's for: it
  // becomes a log event and joins the thread, then whichever node was
  // actually armed for its kind — the interrupt, or this waitFor itself —
  // runs and takes over routing.
  runtime.store.append({ message }, { type: "message", threadId: context.thread.id });
  const thread = withMessage(context.thread, message);
  setThread(thread);

  const interrupt = interrupts.find(
    (candidate) => tryMessageKindOf(candidate.waitable) === message.kind,
  );
  if (interrupt) {
    const stepContext: StepContext = withInputs(context, [message]);
    const emit = await runStep(interrupt.run, stepContext);
    // An interrupt step emitting anything but `output` isn't supported yet.
    if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
    // Read the thread back live rather than the local `thread` above: if
    // the interrupt step called `context.modelCall()`, its reply was
    // folded in via `setThread`, and the local snapshot would otherwise be
    // stale — silently dropping the reply when `commitRoute` builds the
    // next thread.
    const liveThread = context.thread;
    return {
      ...commitRoute(
        runtime,
        liveThread.id,
        flow.edges,
        interrupt.id,
        emit.output,
        { stepId: interrupt.id },
        liveThread,
      ),
      ranInterruptStep: true,
    };
  }

  const waitForResult: WaitForResult = { ok: true, result: message };
  const routed = route(flow.edges, nodeId, waitForResult, thread, runtime);
  return {
    ...routed,
    input: waitForResult,
    ranInterruptStep: false,
  };
}

/**
 * Runs a `waitFor` node: blocks until its `Waitable` is satisfied, then
 * routes off the result. A `userInput`-shaped `Waitable` (today's only
 * message-backed provider) races `waitForRace` against every armed
 * `interrupt` — message-based or signal-based alike — and folds in
 * whichever wins via `driveWaitForMessage` (a message win, whether this
 * node's own or a message-based interrupt's) or the signal-interrupt path
 * below (a signal-based interrupt's own `match()` won instead). Any other
 * provider for this node's own Waitable (e.g. a signal-based one) has no
 * message to fold and no interrupt-arming yet (out of scope for this slice,
 * see waitable.ts); it blocks on `waitForSignal` instead and routes
 * directly on the `Waitable`'s own `match()` result.
 */
async function driveWaitForNode(
  node: Extract<NodeKind, { kind: "waitFor" }>,
  nodeId: NodeId,
  interrupts: InterruptNode[],
  context: StepContext,
  flow: Graph,
  runtime: Runtime,
  setThread: (thread: Thread) => void,
): Promise<RouteResult> {
  const waitKind = tryMessageKindOf(node.waitable);
  if (waitKind === undefined) {
    const result = await waitForSignal(runtime.store, node.waitable);
    return route(
      flow.edges,
      nodeId,
      { ok: true, result } satisfies WaitForResult,
      context.thread,
      runtime,
    );
  }

  const winner = await waitForRace(
    runtime.store,
    waitKind,
    interrupts.map((interrupt) => ({
      id: interrupt.id,
      waitable: interrupt.waitable,
      messageKind: tryMessageKindOf(interrupt.waitable),
    })),
  );

  if (winner.kind === "self") {
    const routed = await driveWaitForMessage(
      winner.message,
      nodeId,
      interrupts,
      context,
      flow,
      runtime,
      setThread,
    );
    return { thread: routed.thread, input: routed.input, reason: routed.reason, to: routed.to };
  }

  const wonMessageKind = tryMessageKindOf(winner.interrupt.waitable);
  if (wonMessageKind !== undefined) {
    // A message-based interrupt won the race: fold the message into the
    // thread and run its step, exactly as `driveWaitForMessage` does when
    // called from the plain (non-racing) path.
    const routed = await driveWaitForMessage(
      winner.value as UserMessage,
      nodeId,
      interrupts,
      context,
      flow,
      runtime,
      setThread,
    );
    return { thread: routed.thread, input: routed.input, reason: routed.reason, to: routed.to };
  }

  // A signal-based interrupt won: there's no message to fold into the
  // thread — same as `waitForSignal`'s own path — so its step runs with the
  // Waitable's `match()` result as its only input, and its output routes
  // exactly like a message-based interrupt's does in `driveWaitForMessage`.
  const interrupt = interrupts.find((candidate) => candidate.id === winner.interrupt.id);
  if (!interrupt) unreachable(`waitForRace resolved to unknown interrupt "${winner.interrupt.id}"`);
  const stepContext: StepContext = withInputs(context, [winner.value]);
  const emit = await runStep(interrupt.run, stepContext);
  if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
  const liveThread = context.thread;
  return commitRoute(
    runtime,
    liveThread.id,
    flow.edges,
    interrupt.id,
    emit.output,
    { stepId: interrupt.id },
    liveThread,
  );
}

/** What handling a step's `Emit` decided: retry the same node, or advance to the next one. */
type StepOutcome =
  { kind: "retry" } | ({ kind: "advance" } & RouteResult & { pendingInputs?: unknown[] });

/** Appends an invalidation event and returns the outcome that reruns the invalidated node — shared by the main-loop and branch paths since both commit an `invalidate` emit the same way. */
function commitInvalidation(
  runtime: Runtime,
  thread: Thread,
  emit: Extract<Emit, { invalidate: NodeId }>,
): StepOutcome {
  const invalidatedThreadId = thread.id;
  const nextThread = applyThreadAction(thread, emit.threadAction, emit.reason, runtime);
  runtime.store.append(
    {
      target: emit.invalidate,
      threadAction: emit.threadAction,
      ...(emit.reason ? { reason: emit.reason } : {}),
    },
    { type: "invalidation", threadId: invalidatedThreadId },
  );
  return {
    kind: "advance",
    thread: nextThread,
    input: undefined,
    reason: undefined,
    to: emit.invalidate,
  };
}

/** The nodes a step's output can fan out into — more than one `then` edge means a fan-out. Shared by `driveStepEmit` (which runs every branch to completion) and tick() (which must detect a fan-out before `driveStepEmit` runs, since it drives one branch per call instead of `Promise.all`). */
export function fanOutTargets(flow: Graph, nodeId: NodeId): NodeId[] {
  return thenEdges(flow.edges, nodeId).map((edge) => edge.to);
}

/**
 * Handles the `Emit` a `step` node produced: invalidate, compact, error, a
 * fan-out (more than one `then` edge), or a plain routed output. Each case
 * decides the next node and, for fan-out, the per-branch inputs the join
 * node receives.
 */
export async function driveStepEmit(
  emit: Emit,
  node: Extract<NodeKind, { kind: "step" }>,
  nodeId: NodeId,
  ctx: ExecutionContext,
): Promise<StepOutcome> {
  const { thread, flow, runtime } = ctx;
  if ("invalidate" in emit) {
    return commitInvalidation(runtime, thread, emit);
  }

  if ("compact" in emit) {
    const nextThread = commitCompaction(runtime, thread, emit.compact, emit.meta);
    return { kind: "advance", ...route(flow.edges, nodeId, undefined, nextThread, runtime) };
  }

  if ("error" in emit) {
    return handleStepError(emit, nodeId, ctx);
  }

  // Emit's variants are exactly invalidate/compact/error/output — having
  // ruled out the first three, only "output" remains; anything else is a bug.
  if (!("output" in emit)) unreachable(`emit "${Object.keys(emit).join(", ")}"`);

  const branchTargets: NodeId[] = fanOutTargets(flow, nodeId);
  if (branchTargets.length > 1) {
    appendOutput(runtime, thread.id, emit.output, stepIdentity(nodeId, node.label));
    // Resolve the convergence node before spawning branches — findJoinNode
    // validates linearity (no nested fan-out) and that all branches share a
    // single common join, replacing the old per-branch joinEdge lookup.
    const joinNodeId = findJoinNode(branchTargets, nodeId, flow);
    const results: BranchResult[] = await Promise.all(
      branchTargets.map((branch: NodeId) =>
        runBranch(branch, emit.output, joinNodeId, {
          ...ctx,
          thread: applyThreadAction(thread, "fork", undefined, runtime),
        }),
      ),
    );

    // A branch that invalidated a node instead of joining means the fan-out
    // step itself must be rerun — same as the main-loop's own invalidate
    // handling, using the pre-fork thread so the rerun lands back on the
    // shared line, not any one branch's forked copy.
    const invalidated = results.find(
      (result): result is Extract<BranchResult, { kind: "invalidate" }> =>
        result.kind === "invalidate",
    );
    if (invalidated) return commitInvalidation(runtime, thread, invalidated.emit);

    const outputs = results.filter(
      (result): result is Extract<BranchResult, { kind: "output" }> => result.kind === "output",
    );
    if (!outputs.length) throw new Error(`fan-out from "${nodeId}" produced no branches`);
    // findJoinNode already ensured all branches converge on joinNodeId.
    return {
      kind: "advance",
      thread,
      input: undefined,
      reason: undefined,
      pendingInputs: outputs.map((result) => result.output),
      to: joinNodeId,
    };
  }

  return {
    kind: "advance",
    ...commitRoute(
      runtime,
      thread.id,
      flow.edges,
      nodeId,
      emit.output,
      stepIdentity(nodeId, node.label),
      thread,
    ),
  };
}

/** What driving a graph to its `finish` node settles with — the final thread and the terminal value. */
interface DriveResult {
  thread: Thread;
  output: unknown;
}

/** Guards that a node is currently running (`current` is set) and looks up its identity — shared by `driveGraph`'s `openStream` and `modelCall`, whose "no running node" guards differ only in their error message. */
function currentNodeIdentity(
  current: NodeId | undefined,
  flow: Graph,
  errorMessage: string,
): StepIdentity {
  if (!current) throw new Error(errorMessage);
  const node = flow.nodes.get(current);
  const label = node?.kind === "step" ? node.label : undefined;
  return stepIdentity(current, label);
}

/**
 * Builds the drive-loop `StepContext` shared by `driveGraph` and `tick`:
 * `openStream`/`modelCall`/`callTool` all resolve the currently running
 * node's identity via `currentNodeIdentity`, reading the running node and
 * its thread through getters — `driveGraph` closes over its `current`/
 * `currentThread` outer variables, `tick` closes over its own same-named
 * loop variables, and either way this sees the live value on each call.
 */
export function buildDriveContext(
  flow: Graph,
  runtime: Runtime,
  getCurrent: () => NodeId | undefined,
  getThread: () => Thread,
  setThread: (thread: Thread) => void,
): StepContext {
  const context = makeStepContext({
    getThread,
    inputs: [],
    openStream: (type) => {
      const identity = currentNodeIdentity(
        getCurrent(),
        flow,
        "openStream called outside a running node",
      );
      return runtime.store.open({
        correlationId: freshCorrelationId(runtime),
        type,
        threadId: getThread().id,
        ...identity,
      });
    },
    modelCall(profile): Promise<ModelCallResult> {
      // modelCall only ever runs while a node is being processed by the
      // caller's drive loop, so getCurrent() is always set at that point. The
      // identity itself is only needed for the guard's own error message —
      // runModelCall no longer runs a tool call inline, so it has no need to
      // attribute one to this node's identity.
      currentNodeIdentity(getCurrent(), flow, "modelCall called outside a running node");
      return runModelCall(profile, context, runtime, setThread);
    },
    callTool<Input, Output>(tool: Tool<Input, Output>, input: Input): Promise<Output> {
      const identity = currentNodeIdentity(
        getCurrent(),
        flow,
        "callTool called outside a running node",
      );
      return callTool(tool, input, getThread().id, runtime, identity);
    },
  });
  return context;
}

/**
 * Drives one graph from its entry node to its `finish` node: runs each step,
 * follows the edge its output selects, mutates the thread as edges and
 * emits dictate, and handles `waitFor`, `interrupt`, `invalidate`, `compact`,
 * and step errors along the way. This is the whole engine loop, factored out
 * so a `use` node can point the same machinery at a subgraph, inline — same
 * thread, same runtime, same log — and resume the outer drive with the
 * subgraph's result once it reaches its own `finish`.
 *
 * `input` is the value the entry node sees, exactly like `initialPrompt` at
 * the top level: usually a `Message` (the flow's or the subgraph's seed), but
 * any node reachable as an entry may read it via `context.inputs[0]`.
 */
export async function driveGraph(
  flow: Graph,
  runtime: Runtime,
  thread: Thread,
  input: unknown,
): Promise<DriveResult> {
  // The live current thread — reassigned (not mutated) by `invalidate`, a
  // `use` node, or a threadAction when it forks or resets. `context.thread`
  // reads it through a getter so every consumer (modelCall, tool calls,
  // invalidate itself) sees the same, up-to-date thread rather than a
  // snapshot captured once at the top.
  let currentThread: Thread = thread;

  let current: NodeId | undefined = flow.entry;
  const context = buildDriveContext(
    flow,
    runtime,
    () => current,
    () => currentThread,
    (next) => {
      currentThread = next;
    },
  );

  const interrupts = findInterruptNodes(flow);
  let currentInput: unknown = input;
  // The edge-resolved prompt (if any) that led to the node we're about to
  // run — what a `use` node seeds its subgraph with when the reaching edge
  // carried a `prompt`. Cleared on any transition that doesn't come from
  // following a routed edge (invalidate, fan-out join).
  let reason: Message | undefined;
  // Set only when the previous step joined a fan-out group — one entry per
  // branch, in declared order — so the next step's `inputs` isn't wrapped a
  // second time around a single `input`.
  let pendingInputs: unknown[] | undefined;
  // Times each node has already errored — bumped only on a "retry" decision,
  // so the node's first error sees attempts: 0. Keyed by node id since a
  // retry re-runs the same node without ever changing `current`.
  const attemptsByNode = new Map<NodeId, number>();

  while (current) {
    const node = flow.nodes.get(current);
    if (!node) throw new Error(`graph "${flow.name}" has no node "${current}"`);

    // Consumed by whichever node runs next, regardless of its kind — a join's
    // pendingInputs must never survive past the node it was meant for.
    const inputs = pendingInputs ?? [currentInput];
    pendingInputs = undefined;

    if (node.kind === "finish") return { thread: currentThread, output: currentInput };

    if (node.kind === "use") {
      const routed = await driveUseNode(node, current, reason, currentInput, {
        flow,
        runtime,
        thread: currentThread,
        attemptsByNode,
      });
      currentThread = routed.thread;
      currentInput = routed.input;
      reason = routed.reason;
      current = routed.to;
      continue;
    }

    if (node.kind === "forEach") {
      const routed = await driveForEachNode(node, current, currentInput, {
        flow,
        runtime,
        thread: currentThread,
        attemptsByNode,
      });
      currentThread = routed.thread;
      currentInput = routed.input;
      reason = routed.reason;
      current = routed.to;
      continue;
    }

    if (node.kind === "waitFor") {
      const routed = await driveWaitForNode(
        node,
        current,
        interrupts,
        context,
        flow,
        runtime,
        (next) => {
          currentThread = next;
        },
      );
      currentThread = routed.thread;
      currentInput = routed.input;
      reason = routed.reason;
      current = routed.to;
      continue;
    }

    // The only remaining declared kind is "interrupt", which is never a
    // routing target — it's only ever entered via `driveWaitForNode` above.
    if (node.kind !== "step") notImplemented(`node kind "${node.kind}"`);

    if (node.label) currentThread = { ...currentThread, label: node.label };

    // Validate JoinStep tagging: a join()-tagged step must receive multiple
    // inputs (from fan-out pendingInputs); see assertJoinTagging.
    assertJoinTagging(current, node.run, inputs);

    const stepContext: StepContext = withInputs(context, inputs);
    const emit = await runStep(node.run, stepContext);

    const outcome = await driveStepEmit(emit, node, current, {
      flow,
      runtime,
      thread: currentThread,
      attemptsByNode,
    });
    if (outcome.kind === "retry") continue;

    currentThread = outcome.thread;
    currentInput = outcome.input;
    reason = outcome.reason;
    pendingInputs = outcome.pendingInputs;
    current = outcome.to;
  }

  return { thread: currentThread, output: currentInput };
}
