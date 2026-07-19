// Systems running flows — runtime / runFlow. See docs/reference.md.

import type { Model } from "../flow/model.js";
import type { Message, MessageKind, UserMessage, AssistantMessage } from "../flow/message.js";
import type { Graph, NodeId, NodeKind, EdgeDefinition } from "../flow/graph.js";
import type { Binding } from "../flow/tool.js";
import type { ThreadId, ThreadAction } from "../flow/thread.js";
import type { StepContext, Emit, ModelCallResult, StepError, Step } from "../flow/step.js";
import type { Tool, ToolContext } from "../flow/tool.js";
import type { DeltaSink } from "../session/envelope.js";
import type { Profile } from "../flow/profile.js";
import type { ContentBlock } from "../flow/message.js";
import type { ModelPort } from "./model-port.js";
import type { SessionStore } from "./session-store.js";
import {
  type ErrorContext,
  type ErrorDecision,
  type ErrorHandler,
  notImplemented,
  unreachable,
} from "./errors.js";

/** What a flow runs against — model resolution, bindings, and store. */
export interface Runtime {
  readonly models: (model: Model) => ModelPort;
  readonly bindings: Binding[];
  readonly store: SessionStore;
  readonly errorHandlers: ErrorHandler[];
}

export function runtime(config: {
  models: (model: Model) => ModelPort;
  bindings: Binding[];
  store: SessionStore;
  errorHandlers?: ErrorHandler[]; // consulted on a step error; a default retry handler runs last
}): Promise<Runtime> {
  return Promise.resolve({
    models: config.models,
    bindings: config.bindings,
    store: config.store,
    errorHandlers: config.errorHandlers ?? [],
  });
}

/**
 * Runs a step, converting an uncaught throw into the same `{ error }` shape
 * as an explicit `context.fail(...)` — the two failure modes share one path.
 */
async function runStep(run: Step, context: StepContext): Promise<Emit> {
  try {
    return await run(context);
  } catch (cause) {
    return {
      error: {
        type: "unexpected",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      },
    };
  }
}

/**
 * Picks the edge a node's output should follow: the first matching `when`,
 * else the `otherwise` edge, else the unconditional `then` edge.
 */
function selectEdge(
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
): EdgeDefinition | undefined {
  const outgoing = edges.filter((candidate) => candidate.from === from);
  const when = outgoing.find(
    (candidate) => candidate.edge === "when" && candidate.condition?.(output),
  );
  if (when) return when;
  const otherwise = outgoing.find((candidate) => candidate.edge === "otherwise");
  if (otherwise) return otherwise;
  return outgoing.find((candidate) => candidate.edge === "then");
}

/** Where a followed edge leads, the thread action it carries, and the reason message (if any) that seeds a new thread. */
interface Advance {
  to: NodeId;
  threadAction: ThreadAction;
  reason?: Message;
}

/** Follows the node's outgoing edge for the given output, or throws if it has none. */
function advance(edges: readonly EdgeDefinition[], from: NodeId, output: unknown): Advance {
  const edge = selectEdge(edges, from, output);
  if (!edge) throw new Error(`node "${from}" has no outgoing edge`);
  const reason = edge.options?.prompt?.(output);
  return {
    to: edge.to,
    threadAction: edge.options?.threadAction ?? "same",
    ...(reason ? { reason } : {}),
  };
}

/** A step's identity for logging purposes — its node id, and its declared label, if any. */
interface StepIdentity {
  stepId: NodeId;
  stepName?: string;
}

/** Builds a StepIdentity from a node id and its optional label — shared by every call site that logs one. */
function stepIdentity(id: NodeId, label?: string): StepIdentity {
  return { stepId: id, ...(label ? { stepName: label } : {}) };
}

/** Appends a node's output event to the log — shared by every path that produces one. */
function appendOutput(
  runtime: Runtime,
  threadId: ThreadId,
  output: unknown,
  step: StepIdentity,
): void {
  runtime.store.append(
    { value: output },
    {
      type: "output",
      threadId,
      stepId: step.stepId,
      ...(step.stepName ? { stepName: step.stepName } : {}),
    },
  );
}

/** Logs a step's output and follows the resulting edge — the shared tail of every node that emits one. */
function commitOutput(
  runtime: Runtime,
  threadId: ThreadId,
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
  step: StepIdentity,
): Advance {
  appendOutput(runtime, threadId, output, step);
  return advance(edges, from, output);
}

/** Applies an edge's threadAction and reports where it leads — the shared tail of following any edge. */
function follow(edge: Advance, thread: Thread): { thread: Thread; to: NodeId } {
  return { thread: applyThreadAction(thread, edge.threadAction, edge.reason), to: edge.to };
}

/** Appends `message` to both a thread's assembled view and its full history — the shared tail of every path that folds one in. */
function pushMessage(thread: { messages: Message[]; history: Message[] }, message: Message): void {
  thread.messages.push(message);
  thread.history.push(message);
}

/**
 * Parks until `poll` returns a value, checking on a timer tick so a
 * synchronous `store.submit()` racing this call — before or after it starts
 * — is never missed. Stops early once `stop` says so, if given.
 */
async function pollInbox<T>(
  poll: () => T | undefined,
  stop?: () => boolean,
): Promise<T | undefined> {
  while (!stop?.()) {
    const value = poll();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return undefined;
}

/** Parks until the inbox has a message of the given kind. */
async function waitForMessage(
  store: SessionStore,
  kinds: readonly MessageKind[],
): Promise<UserMessage> {
  const message = await pollInbox(() =>
    store.consume((candidate) => candidate.kind !== undefined && kinds.includes(candidate.kind)),
  );
  // pollInbox only returns undefined when given a `stop` predicate, which this call omits.
  if (!message) unreachable("waitForMessage resolved without a message");
  return message;
}

/**
 * Parks until an abort message reaches the inbox — same polling shape as
 * `waitForMessage` — but stops the moment `isCancelled` says the race that
 * started it has already been decided some other way, so it doesn't keep
 * draining the inbox for the rest of the process's life.
 */
async function waitForAbort(
  store: SessionStore,
  isCancelled: () => boolean,
): Promise<UserMessage | undefined> {
  return pollInbox(() => store.consume((candidate) => candidate.intent === "abort"), isCancelled);
}

interface InterruptNode {
  id: NodeId;
  messageKind: MessageKind;
  run: Step;
}

/** Every `interrupt` node in the graph — armed for the whole run, not just one node. */
function findInterruptNodes(flow: Graph): InterruptNode[] {
  const interrupts: InterruptNode[] = [];
  for (const [id, node] of flow.nodes) {
    if (node.kind === "interrupt")
      interrupts.push({ id, messageKind: node.messageKind, run: node.run });
  }
  return interrupts;
}

function isToolCall(block: ContentBlock): block is Extract<ContentBlock, { type: "toolCall" }> {
  return block.type === "toolCall";
}

/** Finds the binding for a named tool, or throws if the runtime has none. */
function findToolBinding(runtime: Runtime, name: string): Extract<Binding, { kind: "tool" }> {
  const binding = runtime.bindings.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === name,
  );
  if (binding?.kind !== "tool") throw new Error(`no tool binding for "${name}"`);
  return binding;
}

/** The `ToolContext` every tool handler runs with, wherever it's called from. */
function buildToolContext(threadId: ThreadId, stream: DeltaSink, runtime: Runtime): ToolContext {
  return {
    thread: threadId,
    stream,
    runFlow: (flow, initialPrompt) =>
      runFlow(flow, initialPrompt, runtime, { parentThreadId: threadId }),
  };
}

/**
 * Runs one tool call: logs it, invokes its bound handler, logs the result,
 * and folds the result into the thread as a tool message so the next model
 * call sees it.
 */
async function runToolCall(
  call: Extract<ContentBlock, { type: "toolCall" }>,
  context: StepContext,
  runtime: Runtime,
): Promise<void> {
  const binding = findToolBinding(runtime, call.name);

  runtime.store.append(
    { correlationId: call.correlationId, name: call.name, input: call.input },
    { type: "toolCall", threadId: context.thread.id },
  );

  const toolContext = buildToolContext(context.thread.id, context.stream, runtime);
  const output = await binding.handler(call.input, toolContext);

  runtime.store.append(
    { correlationId: call.correlationId, output },
    { type: "toolResult", threadId: context.thread.id },
  );

  const toolMessage: Message = {
    role: "tool",
    content: [{ type: "toolResult", correlationId: call.correlationId, output }],
  };
  pushMessage(context.thread, toolMessage);
}

/**
 * Calls a tool directly, with no model in the loop: resolves its binding and
 * returns the handler's result as-is — no logging or thread-folding, unlike
 * `runToolCall`, since nothing here asks a model to see the result.
 */
async function callTool<Input, Output>(
  tool: Tool<Input, Output>,
  input: Input,
  threadId: ThreadId,
  stream: DeltaSink,
  runtime: Runtime,
): Promise<Output> {
  const binding = findToolBinding(runtime, tool.name);
  const toolContext = buildToolContext(threadId, stream, runtime);
  return binding.handler(input, toolContext) as Promise<Output>;
}

/**
 * Makes one model request and runs every tool the reply asks for, appending
 * all of it — the reply, each tool call, each tool result — to the log.
 * Does not call the model again itself: a graph loops by routing a step's
 * output back to itself, same as any other edge.
 */
async function runModelCall(
  profile: Profile,
  context: StepContext,
  runtime: Runtime,
  stepId: NodeId,
): Promise<ModelCallResult> {
  const port = runtime.models(profile.model);
  const stream = runtime.store.open({
    correlationId: freshCorrelationId(),
    type: "message",
    stepId,
    threadId: context.thread.id,
  });

  let modelSettled = false;
  const outcome = await Promise.race([
    port
      .respond(profile, context.thread.messages, stream)
      .then((message): { kind: "reply"; message: AssistantMessage } => {
        modelSettled = true;
        return { kind: "reply", message };
      }),
    waitForAbort(runtime.store, () => modelSettled).then(
      (message): { kind: "abort" } | { kind: "reply"; message: AssistantMessage } | undefined =>
        message ? { kind: "abort" } : undefined,
    ),
  ]);

  if (!outcome || outcome.kind === "abort") {
    stream.abort();
    throw new Error("model call aborted");
  }

  const { message: reply } = outcome;
  stream.commit({ message: reply });
  pushMessage(context.thread, reply);

  const toolCalls = reply.content.filter(isToolCall);
  for (const call of toolCalls) {
    await runToolCall(call, context, runtime);
  }

  return { usedTools: toolCalls.length > 0, usage: reply.usage };
}

let nextCorrelationId = 0;
function freshCorrelationId(): string {
  nextCorrelationId += 1;
  return `correlation-${String(nextCorrelationId)}`;
}

let nextThreadId = 0;
function freshThreadId(): ThreadId {
  nextThreadId += 1;
  return `thread-${String(nextThreadId)}` as ThreadId;
}

type Thread = StepContext["thread"];

/**
 * Resolves the thread an invalidated node reruns on, per its `threadAction`:
 * `same` keeps the current thread, pushing `reason` onto it if given; `fork`
 * splits onto a new thread that shares the current thread's history so far,
 * linked back by `forkedFrom`; `new` starts a blank thread whose only message
 * is `reason`, if given.
 */
function applyThreadAction(
  current: Thread,
  threadAction: ThreadAction,
  reason: Message | undefined,
): Thread {
  if (threadAction === "new") {
    const messages = reason ? [reason] : [];
    return { id: freshThreadId(), messages, history: [...messages] };
  }

  if (threadAction === "fork") {
    const messages = [...current.messages];
    const history = [...current.history];
    const forked = { messages, history };
    if (reason) pushMessage(forked, reason);
    return {
      id: freshThreadId(),
      forkedFrom: { thread: current.id, at: current.history.length },
      messages,
      history,
    };
  }

  // "same": no new thread — push the reason onto the one already running.
  if (reason) pushMessage(current, reason);
  return current;
}

/** The `then` edges leaving a node, in declared order — more than one means a fan-out. */
function thenEdges(edges: readonly EdgeDefinition[], from: NodeId): EdgeDefinition[] {
  return edges.filter((candidate) => candidate.from === from && candidate.edge === "then");
}

/** Config that differs between the main-loop StepContext and a fan-out branch's — everything else is shared. */
interface StepContextConfig {
  getThread: () => Thread;
  inputs: unknown[];
  stream: DeltaSink;
  modelCall: (profile: Profile) => Promise<ModelCallResult>;
  callTool: <Input, Output>(tool: Tool<Input, Output>, input: Input) => Promise<Output>;
  compact: (
    replace: (messages: Message[]) => Promise<Message[]>,
    meta?: unknown,
  ) => Promise<Emit<Message[]>>;
  invalidate: (
    target: NodeId,
    options?: { threadAction?: ThreadAction; reason?: Message },
  ) => Emit<never>;
}

/**
 * Builds a `StepContext` from whatever differs between where it runs — the
 * main drive loop or a fan-out branch. Both call this one factory so a later
 * change (filling in a branch's `call`/`compact`/`invalidate` stubs) touches
 * one place instead of two parallel builders.
 */
function makeStepContext(config: StepContextConfig): StepContext {
  return {
    get thread() {
      return config.getThread();
    },
    inputs: config.inputs,
    stream: config.stream,
    modelCall: config.modelCall,
    callTool: config.callTool,
    output<Result>(value: Result): Emit<Result> {
      return { output: value };
    },
    compact: config.compact,
    invalidate: config.invalidate,
    fail(error: StepError): Emit<never> {
      return { error };
    },
  };
}

/**
 * Runs one fan-out branch to completion on its own forked thread. For this
 * slice a branch is exactly one step whose outgoing edge is a `join` — no
 * waitFor/interrupt/invalidate/further fan-out inside a branch, that's out
 * of scope here. Returns the branch's output and the join node its edge
 * points to (every branch in a group points to the same join node).
 */
async function runBranch(
  node: NodeId,
  branchThread: Thread,
  flow: Graph,
  runtime: Runtime,
  input: unknown,
): Promise<{ output: unknown; joinTo: NodeId }> {
  const nodeDef = flow.nodes.get(node);
  if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${node}"`);
  // A branch node kind other than "step" isn't supported yet — the fan-out
  // machinery only ever builds a step's node.run against a branch context.
  if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);
  if (nodeDef.label) branchThread = { ...branchThread, label: nodeDef.label };

  const branchContext = makeStepContext({
    getThread: () => branchThread,
    inputs: [input],
    // Stubs below are filled in by the branch-context-parity story that
    // follows this one; see the seam this factory exists to narrow.
    stream: { delta: () => notImplemented("stream") },
    modelCall: (profile) => runModelCall(profile, branchContext, runtime, node),
    callTool: (tool, toolInput) => {
      void tool;
      void toolInput;
      return notImplemented("callTool");
    },
    compact: () => notImplemented("compact in a fan-out branch"),
    invalidate: () => notImplemented("invalidate in a fan-out branch"),
  });

  const emit = await runStep(nodeDef.run, branchContext);
  if (!("output" in emit)) {
    // A branch step emitting anything but `output` (compact/invalidate/error)
    // isn't supported yet — deliberately out of scope, per the doc above.
    notImplemented(`emit "${Object.keys(emit).join(", ")}" in a fan-out branch`);
  }

  appendOutput(runtime, branchThread.id, emit.output, stepIdentity(node, nodeDef.label));

  const joinEdge = flow.edges.find((edge) => edge.from === node && edge.edge === "join");
  if (!joinEdge) throw new Error(`fan-out branch "${node}" has no join edge`);

  return { output: emit.output, joinTo: joinEdge.to };
}

/** Where routing a node landed: the (possibly new) thread, the value the next node sees, its seed reason, and the next node id. */
interface RouteResult {
  thread: Thread;
  input: unknown;
  reason: Message | undefined;
  to: NodeId;
}

/** Runs a `use` node: seeds its subgraph, drives it inline to its own `finish`, and follows the reaching edge with its result. */
async function driveUseNode(
  node: Extract<NodeKind, { kind: "use" }>,
  nodeId: NodeId,
  thread: Thread,
  reason: Message | undefined,
  currentInput: unknown,
  flow: Graph,
  runtime: Runtime,
): Promise<RouteResult> {
  // The subgraph's initial prompt: the reaching edge's `prompt` output, if it
  // had one (the previous iteration's `follow` already pushed it onto this
  // thread; logged again here so it lands in the log too), otherwise the raw
  // incoming value, trusted to already be a `Message` (never pushed onto the
  // thread, so push it now — this node is its only source).
  const seed: Message = reason ?? (currentInput as Message);
  if (!reason) pushMessage(thread, seed);
  runtime.store.append({ message: seed }, { type: "message", threadId: thread.id });

  const result = await driveGraph(node.subgraph, runtime, thread, seed);

  const edge = commitOutput(
    runtime,
    result.thread.id,
    flow.edges,
    nodeId,
    result.output,
    stepIdentity(nodeId),
  );
  const followed = follow(edge, result.thread);
  return { thread: followed.thread, input: result.output, reason: edge.reason, to: followed.to };
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
    const edge = commitOutput(runtime, thread.id, flow.edges, interrupt.id, emit.output, {
      stepId: interrupt.id,
    });
    const followed = follow(edge, thread);
    return { thread: followed.thread, input: emit.output, reason: edge.reason, to: followed.to };
  }

  const edge = advance(flow.edges, nodeId, message);
  const followed = follow(edge, thread);
  return { thread: followed.thread, input: message, reason: edge.reason, to: followed.to };
}

/** What handling a step's `Emit` decided: retry the same node, or advance to the next one. */
type StepOutcome =
  { kind: "retry" } | ({ kind: "advance" } & RouteResult & { pendingInputs?: unknown[] });

/**
 * Handles the `Emit` a `step` node produced: invalidate, compact, error, a
 * fan-out (more than one `then` edge), or a plain routed output. Each case
 * decides the next node and, for fan-out, the per-branch inputs the join
 * node receives.
 */
async function driveStepEmit(
  emit: Emit,
  node: Extract<NodeKind, { kind: "step" }>,
  nodeId: NodeId,
  thread: Thread,
  flow: Graph,
  runtime: Runtime,
  attemptsByNode: Map<NodeId, number>,
): Promise<StepOutcome> {
  if ("invalidate" in emit) {
    const invalidatedThreadId = thread.id;
    const nextThread = applyThreadAction(thread, emit.threadAction, emit.reason);
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

  if ("compact" in emit) {
    runtime.store.append(
      { messages: emit.compact, ...(emit.meta !== undefined ? { meta: emit.meta } : {}) },
      { type: "compaction", threadId: thread.id },
    );
    thread.messages = emit.compact;
    thread.history.push(...emit.compact);
    const edge = advance(flow.edges, nodeId, undefined);
    const followed = follow(edge, thread);
    return {
      kind: "advance",
      thread: followed.thread,
      input: undefined,
      reason: edge.reason,
      to: followed.to,
    };
  }

  if ("error" in emit) {
    runtime.store.append(
      {
        type: emit.error.type,
        message: emit.error.message,
        ...(emit.error.retryable !== undefined ? { retryable: emit.error.retryable } : {}),
        ...(emit.error.cause !== undefined ? { cause: emit.error.cause } : {}),
      },
      { type: "error", threadId: thread.id },
    );

    const attempts = attemptsByNode.get(nodeId) ?? 0;
    const errorContext: ErrorContext = {
      step: { id: nodeId },
      thread: thread.id,
      attempts,
      log: runtime.store.events(),
    };

    let decision: ErrorDecision | undefined;
    for (const handler of runtime.errorHandlers) {
      decision = handler(emit.error, errorContext);
      if (decision) break;
    }

    if (!decision || decision.action === "fail") {
      throw new Error(emit.error.message, { cause: emit.error });
    }

    attemptsByNode.set(nodeId, attempts + 1);
    if (decision.after) await new Promise((resolve) => setTimeout(resolve, decision.after));
    return { kind: "retry" };
  }

  // Emit's variants are exactly invalidate/compact/error/output — having
  // ruled out the first three, only "output" remains; anything else is a bug.
  if (!("output" in emit)) unreachable(`emit "${Object.keys(emit).join(", ")}"`);

  const branchTargets: NodeId[] = thenEdges(flow.edges, nodeId).map((edge) => edge.to);
  if (branchTargets.length > 1) {
    appendOutput(runtime, thread.id, emit.output, stepIdentity(nodeId, node.label));
    const results: { output: unknown; joinTo: NodeId }[] = await Promise.all(
      branchTargets.map((branch: NodeId) =>
        runBranch(branch, applyThreadAction(thread, "fork", undefined), flow, runtime, emit.output),
      ),
    );
    const [firstBranch, ...restOfBranches] = results;
    if (!firstBranch) throw new Error(`fan-out from "${nodeId}" produced no branches`);
    const joinTo = firstBranch.joinTo;
    const disagreement = restOfBranches.find((result) => result.joinTo !== joinTo);
    if (disagreement) {
      throw new Error(
        `fan-out from "${nodeId}" has branches joining different nodes ("${joinTo}" vs "${disagreement.joinTo}")`,
      );
    }
    return {
      kind: "advance",
      thread,
      input: undefined,
      reason: undefined,
      pendingInputs: results.map((result: { output: unknown }) => result.output),
      to: joinTo,
    };
  }

  const edge = commitOutput(
    runtime,
    thread.id,
    flow.edges,
    nodeId,
    emit.output,
    stepIdentity(nodeId, node.label),
  );
  const followed = follow(edge, thread);
  return {
    kind: "advance",
    thread: followed.thread,
    input: emit.output,
    reason: edge.reason,
    to: followed.to,
  };
}

/** What driving a graph to its `finish` node settles with — the final thread and the terminal value. */
interface DriveResult {
  thread: Thread;
  output: unknown;
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
async function driveGraph(
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

  const context = makeStepContext({
    getThread: () => currentThread,
    inputs: [],
    stream: { delta: () => notImplemented("stream") },
    modelCall(profile): Promise<ModelCallResult> {
      // modelCall only ever runs while a node is being processed inside the
      // loop below, so `current` is always set at that point.
      if (!current) throw new Error("modelCall called outside a running node");
      return runModelCall(profile, context, runtime, current);
    },
    callTool<Input, Output>(tool: Tool<Input, Output>, input: Input): Promise<Output> {
      return callTool(tool, input, currentThread.id, context.stream, runtime);
    },
    async compact(replace, meta): Promise<Emit<Message[]>> {
      const messages = await replace(currentThread.messages);
      return { compact: messages, ...(meta !== undefined ? { meta } : {}) };
    },
    invalidate(target, options): Emit<never> {
      return {
        invalidate: target,
        threadAction: options?.threadAction ?? "same",
        ...(options?.reason ? { reason: options.reason } : {}),
      };
    },
  });

  const interrupts = findInterruptNodes(flow);
  let current: NodeId | undefined = flow.entry;
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
      const routed = await driveUseNode(
        node,
        current,
        currentThread,
        reason,
        currentInput,
        flow,
        runtime,
      );
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

    const stepContext: StepContext = { ...context, inputs };
    const emit = await runStep(node.run, stepContext);

    const outcome = await driveStepEmit(
      emit,
      node,
      current,
      currentThread,
      flow,
      runtime,
      attemptsByNode,
    );
    if (outcome.kind === "retry") continue;

    currentThread = outcome.thread;
    currentInput = outcome.input;
    reason = outcome.reason;
    pendingInputs = outcome.pendingInputs;
    current = outcome.to;
  }

  return { thread: currentThread, output: currentInput };
}

/**
 * Seeds a new session with a user message, drives it to completion, and
 * resolves with the terminal output. A `parentThreadId` makes it a child —
 * how a tool spawns a sub-agent.
 */
export async function runFlow(
  flow: Graph,
  initialPrompt: Message,
  runtime: Runtime,
  options?: { parentThreadId?: ThreadId },
): Promise<unknown> {
  const threadId = freshThreadId();
  const thread: Thread = {
    id: threadId,
    ...(options?.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
    messages: [initialPrompt],
    history: [initialPrompt],
  };

  runtime.store.append({ message: initialPrompt }, { type: "message", threadId });

  const result = await driveGraph(flow, runtime, thread, initialPrompt);
  return result.output;
}
