// Systems running flows — runtime / runFlow. See docs/reference.md.

import type { Model } from "../flow/model.js";
import type { Message, MessageKind, UserMessage, AssistantMessage } from "../flow/message.js";
import type { Graph, NodeId, NodeKind, EdgeDefinition } from "../flow/graph.js";
import type { Binding } from "../flow/tool.js";
import type { ThreadId, ThreadAction } from "../flow/thread.js";
import type {
  StepContext,
  Emit,
  ModelCallResult,
  StepError,
  Step,
  WaitForResult,
} from "../flow/step.js";
import type { Tool, ToolContext, ToolHandler } from "../flow/tool.js";
import type { Stream } from "../session/envelope.js";
import type { Event, EventType } from "../session/event.js";
import type { Profile } from "../flow/profile.js";
import type { ContentBlock } from "../flow/message.js";
import type { ModelPort } from "./model-port.js";
import type { SessionStore } from "./session-store.js";
import {
  type ErrorContext,
  type ErrorDecision,
  type ErrorHandler,
  defaultErrorHandler,
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

/** Resolves every `kind === "toolset"` binding's members (via its `discover()`, called exactly once) merged with every `kind === "tool"` binding — a single name-keyed lookup `findToolBinding` reads from. Keyed off the returned `Runtime` in a module-scoped `WeakMap` rather than the public type, so this stays an implementation detail (see docs/reference.md's `Runtime` interface). */
const resolvedTools = new WeakMap<Runtime, Map<string, ToolHandler>>();

/** Expands every binding into one name -> handler map: direct tool bindings as-is, toolset bindings via their `discover()`, called once each. */
async function expandToolsets(bindings: Binding[]): Promise<Map<string, ToolHandler>> {
  const resolved = new Map<string, ToolHandler>();
  for (const binding of bindings) {
    if (binding.kind === "tool") {
      resolved.set(binding.tool.name, binding.handler);
      continue;
    }
    const members = await binding.discover();
    for (const [name, handler] of Object.entries(members)) {
      resolved.set(name, handler);
    }
  }
  return resolved;
}

export async function runtime(config: {
  models: (model: Model) => ModelPort;
  bindings: Binding[];
  store: SessionStore;
  errorHandlers?: ErrorHandler[]; // consulted on a step error; a default retry handler runs last
}): Promise<Runtime> {
  const ready: Runtime = {
    models: config.models,
    bindings: config.bindings,
    store: config.store,
    errorHandlers: [...(config.errorHandlers ?? []), defaultErrorHandler],
  };
  resolvedTools.set(ready, await expandToolsets(config.bindings));
  return ready;
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

/** Finds the resolved handler for a named tool — direct or a toolset member — or throws if the runtime has none. */
function findToolBinding(runtime: Runtime, name: string): ToolHandler {
  const handler = resolvedTools.get(runtime)?.get(name);
  if (!handler) throw new Error(`no tool binding for "${name}"`);
  return handler;
}

/** The `ToolContext` every tool handler runs with, wherever it's called from. */
function buildToolContext(
  threadId: ThreadId,
  runtime: Runtime,
  identity: StepIdentity,
): ToolContext {
  return {
    thread: threadId,
    openStream: (type) =>
      runtime.store.open({
        correlationId: freshCorrelationId(),
        type,
        threadId,
        ...identity,
      }),
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
  identity: StepIdentity,
): Promise<void> {
  const handler = findToolBinding(runtime, call.name);

  runtime.store.append(
    { correlationId: call.correlationId, name: call.name, input: call.input },
    { type: "toolCall", threadId: context.thread.id },
  );

  const toolContext = buildToolContext(context.thread.id, runtime, identity);
  const output = await handler(call.input, toolContext);

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
  runtime: Runtime,
  identity: StepIdentity,
): Promise<Output> {
  const handler = findToolBinding(runtime, tool.name);
  const toolContext = buildToolContext(threadId, runtime, identity);
  return handler(input, toolContext) as Promise<Output>;
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
  identity: StepIdentity,
): Promise<ModelCallResult> {
  const port = runtime.models(profile.model);
  const stream = context.openStream("message");

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
    await runToolCall(call, context, runtime, identity);
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

/** Appends a compaction event and replaces a thread's messages/history — shared by the main-loop and branch paths since both commit a `compact` emit the same way. */
function commitCompaction(
  runtime: Runtime,
  thread: Thread,
  compact: Message[],
  meta: unknown,
): void {
  runtime.store.append(
    { messages: compact, ...(meta !== undefined ? { meta } : {}) },
    { type: "compaction", threadId: thread.id },
  );
  thread.messages = compact;
  thread.history.push(...compact);
}

/** Appends an invalidation event and returns the outcome that reruns the invalidated node — shared by the main-loop and branch paths since both commit an `invalidate` emit the same way. */
function commitInvalidation(
  runtime: Runtime,
  thread: Thread,
  emit: Extract<Emit, { invalidate: NodeId }>,
): StepOutcome {
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

/**
 * Handles a step's `error` emit: logs it, consults the runtime's error
 * handlers, and either decides to retry the node (bumping its attempt count)
 * or throws to fail the whole run. Shared by the main-loop and branch paths
 * since both drive a step's error the same way.
 */
async function handleStepError(
  emit: Extract<Emit, { error: StepError }>,
  nodeId: NodeId,
  threadId: ThreadId,
  runtime: Runtime,
  attemptsByNode: Map<NodeId, number>,
): Promise<{ kind: "retry" }> {
  runtime.store.append(
    {
      type: emit.error.type,
      message: emit.error.message,
      ...(emit.error.retryable !== undefined ? { retryable: emit.error.retryable } : {}),
      ...(emit.error.cause !== undefined ? { cause: emit.error.cause } : {}),
    },
    { type: "error", threadId },
  );

  const attempts = attemptsByNode.get(nodeId) ?? 0;
  const errorContext: ErrorContext = {
    step: { id: nodeId },
    thread: threadId,
    attempts,
    log: runtime.store.events(),
  };

  let resolvedDecision: ErrorDecision | undefined;
  for (const handler of runtime.errorHandlers) {
    resolvedDecision = handler(emit.error, errorContext);
    if (resolvedDecision) break;
  }
  // runtime() always appends defaultErrorHandler last, and it never itself
  // returns undefined, so the loop above always settles on a decision.
  if (resolvedDecision === undefined)
    unreachable("handleStepError: no error handler produced a decision");
  const decision = resolvedDecision;

  if (decision.action === "fail") {
    throw new Error(emit.error.message, { cause: emit.error });
  }

  attemptsByNode.set(nodeId, attempts + 1);
  if (decision.after) await new Promise((resolve) => setTimeout(resolve, decision.after));
  return { kind: "retry" };
}

/** Config that differs between the main-loop StepContext and a fan-out branch's — everything else is shared. */
interface StepContextConfig {
  getThread: () => Thread;
  inputs: unknown[];
  openStream: (type: EventType) => Stream; // on-demand stream factory model calls and steps use to create a logged event
  modelCall: (profile: Profile) => Promise<ModelCallResult>;
  callTool: <Input, Output>(tool: Tool<Input, Output>, input: Input) => Promise<Output>;
}

/**
 * Builds a `StepContext` from whatever differs between where it runs — the
 * main drive loop or a fan-out branch. Both call this one factory so a later
 * change (filling in a branch's `call` stub) touches
 * one place instead of two parallel builders.
 */
function makeStepContext(config: StepContextConfig): StepContext {
  return {
    get thread() {
      return config.getThread();
    },
    inputs: config.inputs,
    openStream: config.openStream,
    modelCall: config.modelCall,
    callTool: config.callTool,
    output<Result>(value: Result): Emit<Result> {
      return { output: value };
    },
    async compact(replace, meta): Promise<Emit<Message[]>> {
      const messages = await replace(config.getThread().messages);
      return { compact: messages, ...(meta !== undefined ? { meta } : {}) };
    },
    invalidate(target, options): Emit<never> {
      return {
        invalidate: target,
        threadAction: options?.threadAction ?? "same",
        ...(options?.reason ? { reason: options.reason } : {}),
      };
    },
    fail(error: StepError): Emit<never> {
      return { error };
    },
  };
}

/** What running one fan-out branch to completion settled with — a normal reach of its own join edge, or a nested `invalidate` emit that means the fan-out step itself must be rerun instead of joining. */
type BranchResult =
  | { kind: "output"; output: unknown; joinTo: NodeId }
  | { kind: "invalidate"; emit: Extract<Emit, { invalidate: NodeId }> };

/**
 * Runs one fan-out branch to completion on its own forked thread. For this
 * slice a branch is exactly one step whose outgoing edge is a `join` — no
 * waitFor/interrupt/further fan-out inside a branch, that's out of scope
 * here. `callTool`/`compact`/`invalidate` share the same behaviour as the
 * main loop's (see `makeStepContext`); a `compact` emit commits and heads
 * straight to the join edge, an `invalidate` emit bubbles up to the caller
 * instead of being acted on locally (see the fan-out handling in
 * `driveStepEmit`), and an `error` emit goes through the same retry-or-fail
 * handling the main loop uses before either retrying this same node or
 * throwing to fail the whole run.
 */
async function runBranch(
  node: NodeId,
  branchThread: Thread,
  flow: Graph,
  runtime: Runtime,
  input: unknown,
  attemptsByNode: Map<NodeId, number>,
): Promise<BranchResult> {
  const nodeDef = flow.nodes.get(node);
  if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${node}"`);
  // A branch node kind other than "step" isn't supported yet — the fan-out
  // machinery only ever builds a step's node.run against a branch context.
  if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);
  if (nodeDef.label) branchThread = { ...branchThread, label: nodeDef.label };
  const nodeIdentity = stepIdentity(node, nodeDef.label);

  const branchContext = makeStepContext({
    getThread: () => branchThread,
    inputs: [input],
    openStream: (type) =>
      runtime.store.open({
        correlationId: freshCorrelationId(),
        type,
        threadId: branchThread.id,
        ...nodeIdentity,
      }),
    modelCall: (profile) => runModelCall(profile, branchContext, runtime, nodeIdentity),
    callTool: (tool, toolInput) =>
      callTool(tool, toolInput, branchThread.id, runtime, nodeIdentity),
  });

  const joinEdge = flow.edges.find((edge) => edge.from === node && edge.edge === "join");
  if (!joinEdge) throw new Error(`fan-out branch "${node}" has no join edge`);

  for (;;) {
    const emit = await runStep(nodeDef.run, branchContext);

    if ("invalidate" in emit) return { kind: "invalidate", emit };

    if ("compact" in emit) {
      commitCompaction(runtime, branchThread, emit.compact, emit.meta);
      return { kind: "output", output: undefined, joinTo: joinEdge.to };
    }

    if ("error" in emit) {
      await handleStepError(emit, node, branchThread.id, runtime, attemptsByNode);
      continue;
    }

    if (!("output" in emit))
      unreachable(`emit "${Object.keys(emit).join(", ")}" in a fan-out branch`);

    appendOutput(runtime, branchThread.id, emit.output, nodeIdentity);
    return { kind: "output", output: emit.output, joinTo: joinEdge.to };
  }
}

/** Where routing a node landed: the (possibly new) thread, the value the next node sees, its seed reason, and the next node id. */
interface RouteResult {
  thread: Thread;
  input: unknown;
  reason: Message | undefined;
  to: NodeId;
}

/** Distinguishes a real `Message` from a plain marker value (e.g. `waitFor`'s `WaitForResult`) reaching a `use` node as its incoming value. */
function looksLikeMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value && "content" in value;
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
  return {
    thread: followed.thread,
    input: { ok: true } satisfies WaitForResult,
    reason: edge.reason,
    to: followed.to,
  };
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
    return commitInvalidation(runtime, thread, emit);
  }

  if ("compact" in emit) {
    commitCompaction(runtime, thread, emit.compact, emit.meta);
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
    return handleStepError(emit, nodeId, thread.id, runtime, attemptsByNode);
  }

  // Emit's variants are exactly invalidate/compact/error/output — having
  // ruled out the first three, only "output" remains; anything else is a bug.
  if (!("output" in emit)) unreachable(`emit "${Object.keys(emit).join(", ")}"`);

  const branchTargets: NodeId[] = thenEdges(flow.edges, nodeId).map((edge) => edge.to);
  if (branchTargets.length > 1) {
    appendOutput(runtime, thread.id, emit.output, stepIdentity(nodeId, node.label));
    const results: BranchResult[] = await Promise.all(
      branchTargets.map((branch: NodeId) =>
        runBranch(
          branch,
          applyThreadAction(thread, "fork", undefined),
          flow,
          runtime,
          emit.output,
          attemptsByNode,
        ),
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
    const [firstBranch, ...restOfBranches] = outputs;
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
      pendingInputs: outputs.map((result) => result.output),
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
function buildDriveContext(
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
        correlationId: freshCorrelationId(),
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

/** One `tick`'s outcome: a node ran (call again), the flow parked at a `waitFor` with nothing to consume, or it finished. */
export type TickOutcome =
  { status: "advanced" } | { status: "suspended" } | { status: "done"; result: unknown };

/** Where a fresh replay of `runtime.store`'s committed events left off: the node to run next, the thread it runs on, and the value it sees as input. */
interface ReplayPosition {
  current: NodeId;
  thread: Thread;
  currentInput: unknown;
  // The edge-resolved prompt (if any) that led to `current` — what a `use`
  // node reached next would seed its subgraph with. Mirrors driveGraph's
  // own `reason` variable, reconstructed the same way from replay.
  reason?: Message;
}

/**
 * Reconstructs `tick`'s position purely from `runtime.store.events()` — no
 * state survives anywhere else. Starts at `flow.entry` with a fresh thread
 * when the log is empty, then replays every committed `output` (a step ran;
 * follow the edge its value selects, same as `advance`) and `message` (a
 * `waitFor` consumed one; follow *its* edge the same way) event in order,
 * landing exactly where the last tick call left off.
 */
function replayPosition(flow: Graph, store: SessionStore): ReplayPosition {
  let current: NodeId = flow.entry;
  let currentInput: unknown;
  let thread: Thread = { id: freshThreadId(), messages: [], history: [] };
  let reason: Message | undefined;

  for (const envelope of store.events()) {
    if (envelope.form !== "committed") continue;
    if (envelope.threadId) thread = { ...thread, id: envelope.threadId };

    if (envelope.type === "output") {
      const { value } = envelope.event as Event["output"];
      const stepId = envelope.stepId as NodeId;
      // A `use` node drives its whole subgraph inline (see `driveUseNode`),
      // so its inner steps' own output events carry NodeIds that belong to
      // a different, inner Graph — not this `flow`. Replaying those with
      // `advance(flow.edges, ...)` would either throw (no such node in
      // `flow.edges`) or, worse, coincidentally match an unrelated outer
      // node id. Only an output event whose stepId is actually a node in
      // this flow can move `current` — everything else is inner noise to
      // skip over. The `use` node's own final output (tagged with its
      // outer nodeId by `commitOutput`) always passes this check.
      if (!flow.nodes.has(stepId)) continue;
      // A fan-out node's own output event has more than one outgoing `then`
      // edge; replaying it with `advance` would silently pick just the
      // first branch (see `selectEdge`) and desync from what actually ran.
      // Fan-out replay isn't implemented — throw rather than resume wrong.
      if (thenEdges(flow.edges, stepId).length > 1)
        notImplemented("replayPosition: fan-out replay");
      const edge = advance(flow.edges, stepId, value);
      const followed = follow(edge, thread);
      thread = followed.thread;
      current = followed.to;
      currentInput = value;
      reason = edge.reason;
      continue;
    }

    if (envelope.type === "message") {
      const { message } = envelope.event as Event["message"];
      const node = flow.nodes.get(current);
      // Only a `waitFor` actually sitting at `current` in THIS flow
      // advances on a message event. A `use` node's own seed message (and
      // any further message events a nested waitFor inside its subgraph
      // might produce) leave `current` on the `use` node itself — those
      // never move this flow's position, only the inner `driveGraph` call
      // that already ran to completion within a single `tick` call.
      if (node?.kind === "waitFor") {
        pushMessage(thread, message);
        const edge = advance(flow.edges, current, message);
        const followed = follow(edge, thread);
        thread = followed.thread;
        current = followed.to;
        currentInput = { ok: true } satisfies WaitForResult;
        reason = edge.reason;
        continue;
      }
      if (node?.kind === "use") {
        // Mirrors driveUseNode's own dedup: when `reason` is already set,
        // the reaching edge's prompt was already pushed onto this thread
        // by the preceding output event's `follow` — this message event is
        // just its log echo, not a second message to fold in.
        if (!reason) pushMessage(thread, message);
        continue;
      }
      // Belongs to a node driveUseNode drove that isn't `current` in this
      // flow — the subgraph's own waitFor or a deeper nested use. Skipping
      // it (rather than throwing) is safe as long as it never needs to
      // move `current`, which is true for every shape this slice targets.
      continue;
    }
    // toolCall/toolResult/compaction/invalidation/error don't move the main
    // position on their own — out of scope for this slice's replay.
  }

  return { current, thread, currentInput, ...(reason ? { reason } : {}) };
}

/**
 * Advances a flow exactly one node, reconstructing where it is purely from
 * `runtime.store` — no state may survive in a JS closure between calls, so a
 * fresh `Runtime` object (same store) resumes exactly like the original one.
 *
 * A `waitFor` that already has a matching message waiting is "free": it's
 * consumed and its edge followed inline, without counting as this tick's one
 * step — so resuming at a `waitFor` and reaching `finish` in the same call
 * (no work left to run in between) reports `done`, not `advanced`.
 */
export async function tick(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  const interrupts = findInterruptNodes(flow);
  const attemptsByNode = new Map<NodeId, number>();
  const position = replayPosition(flow, runtime.store);
  let currentThread: Thread = position.thread;
  let current: NodeId = position.current;
  let currentInput: unknown = position.currentInput;
  let ranStep = false;
  let reason: Message | undefined = position.reason;

  const context = buildDriveContext(
    flow,
    runtime,
    () => current,
    () => currentThread,
  );

  for (;;) {
    const node = flow.nodes.get(current);
    if (!node) throw new Error(`graph "${flow.name}" has no node "${current}"`);

    if (node.kind === "finish") return { status: "done", result: currentInput };

    if (node.kind === "waitFor") {
      if (ranStep) return { status: "advanced" };
      const kinds = [node.messageKind, ...interrupts.map((interrupt) => interrupt.messageKind)];
      const message = runtime.store.consume(
        (candidate) => candidate.kind !== undefined && kinds.includes(candidate.kind),
      );
      if (!message) return { status: "suspended" };

      runtime.store.append({ message }, { type: "message", threadId: currentThread.id });
      pushMessage(currentThread, message);

      const interrupt = interrupts.find((candidate) => candidate.messageKind === message.kind);
      if (interrupt) {
        const stepContext: StepContext = { ...context, inputs: [message] };
        const emit = await runStep(interrupt.run, stepContext);
        if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
        const edge = commitOutput(
          runtime,
          currentThread.id,
          flow.edges,
          interrupt.id,
          emit.output,
          {
            stepId: interrupt.id,
          },
        );
        const followed = follow(edge, currentThread);
        currentThread = followed.thread;
        current = followed.to;
        currentInput = emit.output;
        ranStep = true;
        reason = edge.reason;
      } else {
        const edge = advance(flow.edges, current, message);
        const followed = follow(edge, currentThread);
        currentThread = followed.thread;
        current = followed.to;
        currentInput = { ok: true } satisfies WaitForResult;
        reason = edge.reason;
      }
      continue;
    }

    if (node.kind === "use") {
      if (ranStep) return { status: "advanced" };
      const entryNode = node.subgraph.nodes.get(node.subgraph.entry);
      if (entryNode?.kind === "waitFor") {
        const kinds = [
          entryNode.messageKind,
          ...interrupts.map((interrupt) => interrupt.messageKind),
        ];
        const ready = runtime.store
          .inbox()
          .some((candidate) => candidate.kind !== undefined && kinds.includes(candidate.kind));
        if (!ready) notImplemented("tick: use node's subgraph starts with an unready waitFor");
      }
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
      ranStep = true;
      continue;
    }

    if (node.kind !== "step") notImplemented(`tick: node kind "${node.kind}"`);

    if (ranStep) return { status: "advanced" };

    if (node.label) currentThread = { ...currentThread, label: node.label };

    const stepContext: StepContext = { ...context, inputs: [currentInput] };
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
    if (outcome.pendingInputs) notImplemented("tick: fan-out");

    currentThread = outcome.thread;
    currentInput = outcome.input;
    reason = outcome.reason;
    current = outcome.to;
    ranStep = true;
  }
}

/** Calls `tick` until it stops advancing — either suspended at a `waitFor`, or done. */
export async function tickUntilSuspended(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  for (;;) {
    const outcome = await tick(flow, runtime);
    if (outcome.status !== "advanced") return outcome;
  }
}
