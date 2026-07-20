// The drive loop: runs a graph node by node from its entry to its `finish`
// node, handling `use`, `waitFor`, invalidate, compact, step errors, and
// fan-out along the way. This is the whole engine loop — shared by the
// top-level runFlow drive and any `use` node's inline subgraph drive — and
// tick()'s own live execution reuses several of its pieces (buildDriveContext,
// findInterruptNodes, driveStepEmit, looksLikeMessage) to drive one node at a
// time instead of to completion.

import type { Graph, NodeId, NodeKind } from "../../flow/graph.js";
import type { Message, MessageKind } from "../../flow/message.js";
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
  pushMessage,
  thenEdges,
} from "./routing.js";
import {
  runStep,
  makeStepContext,
  assertJoinTagging,
  commitCompaction,
  handleStepError,
  type ExecutionContext,
} from "./step-runner.js";
import { runModelCall, callTool, waitForMessage } from "./execution.js";
import { findJoinNode, runBranch, type BranchResult } from "./fan-out.js";

export interface InterruptNode {
  id: NodeId;
  messageKind: MessageKind;
  run: Step;
}

/** Every `interrupt` node in the graph — armed for the whole run, not just one node. */
export function findInterruptNodes(flow: Graph): InterruptNode[] {
  const interrupts: InterruptNode[] = [];
  for (const [id, node] of flow.nodes) {
    if (node.kind === "interrupt")
      interrupts.push({ id, messageKind: node.messageKind, run: node.run });
  }
  return interrupts;
}

/** Distinguishes a real `Message` from a plain marker value (e.g. `waitFor`'s `WaitForResult`) reaching a `use` node as its incoming value. */
export function looksLikeMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value && "content" in value;
}

/** Runs a `use` node: seeds its subgraph, drives it inline to its own `finish`, and follows the reaching edge with its result. */
async function driveUseNode(
  node: Extract<NodeKind, { kind: "use" }>,
  nodeId: NodeId,
  reason: Message | undefined,
  currentInput: unknown,
  ctx: ExecutionContext,
): Promise<RouteResult> {
  const { thread, flow, runtime } = ctx;
  // The subgraph's initial prompt: the reaching edge's `prompt` output, if it
  // had one (the previous iteration's `follow` already pushed it onto this
  // thread; logged again here so it lands in the log too), otherwise the raw
  // incoming value if it's a real `Message` (never pushed onto the thread, so
  // push it now — this node is its only source), or — when the incoming value
  // is a non-message marker such as `waitFor`'s `{ ok: true }` — the message
  // that marker stands for, already the thread's last message.
  const fallback: Message | undefined = thread.messages.at(-1);
  const seed: Message | undefined =
    reason ?? (looksLikeMessage(currentInput) ? currentInput : fallback);
  if (!seed) throw new Error("use node has no message to seed its subgraph with");
  if (!reason) pushMessage(thread, seed);
  runtime.store.append({ message: seed }, { type: "message", threadId: thread.id });

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
 * Runs a `waitFor` node: parks until a matching message (or an armed
 * interrupt's) arrives, folds it into the thread, then either hands routing
 * to the interrupt it was for or advances this node's own edge.
 */
async function driveWaitForNode(
  node: Extract<NodeKind, { kind: "waitFor" }>,
  nodeId: NodeId,
  thread: Thread,
  interrupts: InterruptNode[],
  context: StepContext,
  flow: Graph,
  runtime: Runtime,
): Promise<RouteResult> {
  const message = await waitForMessage(runtime.store, [
    node.messageKind,
    ...interrupts.map((interrupt) => interrupt.messageKind),
  ]);

  // Consuming the message is the same step regardless of who it's for: it
  // becomes a log event and joins the thread, then whichever node was
  // actually armed for its kind — the interrupt, or this waitFor itself —
  // runs and takes over routing.
  runtime.store.append({ message }, { type: "message", threadId: thread.id });
  pushMessage(thread, message);

  const interrupt = interrupts.find((candidate) => candidate.messageKind === message.kind);
  if (interrupt) {
    const stepContext: StepContext = { ...context, inputs: [message] };
    const emit = await runStep(interrupt.run, stepContext);
    // An interrupt step emitting anything but `output` isn't supported yet.
    if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
    return commitRoute(
      runtime,
      thread.id,
      flow.edges,
      interrupt.id,
      emit.output,
      { stepId: interrupt.id },
      thread,
    );
  }

  const routed = route(flow.edges, nodeId, message, thread, runtime);
  return { ...routed, input: { ok: true } satisfies WaitForResult };
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
    commitCompaction(runtime, thread, emit.compact, emit.meta);
    return { kind: "advance", ...route(flow.edges, nodeId, undefined, thread, runtime) };
  }

  if ("error" in emit) {
    return handleStepError(emit, nodeId, ctx);
  }

  // Emit's variants are exactly invalidate/compact/error/output — having
  // ruled out the first three, only "output" remains; anything else is a bug.
  if (!("output" in emit)) unreachable(`emit "${Object.keys(emit).join(", ")}"`);

  const branchTargets: NodeId[] = thenEdges(flow.edges, nodeId).map((edge) => edge.to);
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
      // caller's drive loop, so getCurrent() is always set at that point.
      const identity = currentNodeIdentity(
        getCurrent(),
        flow,
        "modelCall called outside a running node",
      );
      return runModelCall(profile, context, runtime, identity);
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

    if (node.kind === "waitFor") {
      const routed = await driveWaitForNode(
        node,
        current,
        currentThread,
        interrupts,
        context,
        flow,
        runtime,
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

    const stepContext: StepContext = { ...context, inputs };
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
