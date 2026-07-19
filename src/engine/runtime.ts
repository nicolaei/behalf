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

/** What a flow runs against — model resolution, bindings, and store. @public */
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

/** Builds a ready-to-run Runtime, expanding all toolset bindings. @public */
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

/** What running one fan-out branch to completion settled with — a normal reach of its convergence node, or a nested `invalidate` emit that means the fan-out step itself must be rerun instead of joining. */
type BranchResult =
  | { kind: "output"; output: unknown }
  | { kind: "invalidate"; emit: Extract<Emit, { invalidate: NodeId }> };

/**
 * Walks each branch's linear .then() chain to find the node where all
 * branches converge. Throws notImplemented if any step inside a branch itself
 * fans out (multiple .then() edges), and throws if the branches never reach
 * a common node.
 */
function findJoinNode(branchTargets: NodeId[], fanOutNodeId: NodeId, flow: Graph): NodeId {
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
async function runBranchNode(
  nodeId: NodeId,
  thread: Thread,
  flow: Graph,
  runtime: Runtime,
  input: unknown,
  attemptsByNode: Map<NodeId, number>,
): Promise<
  | { kind: "invalidate"; emit: Extract<Emit, { invalidate: NodeId }> }
  | { kind: "output"; output: unknown }
> {
  const nodeDef = flow.nodes.get(nodeId);
  if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${nodeId}"`);
  if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);
  const nodeIdentity = stepIdentity(nodeId, nodeDef.label);

  const branchContext: StepContext = makeStepContext({
    getThread: () => thread,
    inputs: [input],
    openStream: (type) =>
      runtime.store.open({
        correlationId: freshCorrelationId(),
        type,
        threadId: thread.id,
        ...nodeIdentity,
      }),
    modelCall: (profile) => runModelCall(profile, branchContext, runtime, nodeIdentity),
    callTool: (tool, toolInput) => callTool(tool, toolInput, thread.id, runtime, nodeIdentity),
  });

  let stepOutput: unknown = undefined;
  for (;;) {
    const emit = await runStep(nodeDef.run, branchContext);

    if ("invalidate" in emit) return { kind: "invalidate", emit };

    if ("compact" in emit) {
      commitCompaction(runtime, thread, emit.compact, emit.meta);
      break; // stepOutput stays undefined; advance to next node
    }

    if ("error" in emit) {
      await handleStepError(emit, nodeId, thread.id, runtime, attemptsByNode);
      continue;
    }

    if (!("output" in emit))
      unreachable(`emit "${Object.keys(emit).join(", ")}" in a fan-out branch`);

    appendOutput(runtime, thread.id, emit.output, nodeIdentity);
    stepOutput = emit.output;
    break;
  }
  return { kind: "output", output: stepOutput };
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
async function runBranch(
  startNode: NodeId,
  initialThread: Thread,
  flow: Graph,
  runtime: Runtime,
  input: unknown,
  attemptsByNode: Map<NodeId, number>,
  joinNodeId: NodeId,
): Promise<BranchResult> {
  let currentNode = startNode;
  let currentThread = initialThread;
  let currentInput = input;

  for (;;) {
    const nodeDef = flow.nodes.get(currentNode);
    if (!nodeDef) throw new Error(`graph "${flow.name}" has no node "${currentNode}"`);
    if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);
    if (nodeDef.label) currentThread = { ...currentThread, label: nodeDef.label };

    const result = await runBranchNode(
      currentNode,
      currentThread,
      flow,
      runtime,
      currentInput,
      attemptsByNode,
    );
    if (result.kind === "invalidate") return result;

    // Follow the step's single outgoing then edge.
    const thenEdge = flow.edges.find((e) => e.from === currentNode && e.edge === "then");
    if (!thenEdge)
      throw new Error(`fan-out branch step "${currentNode}" has no outgoing then edge`);

    if (thenEdge.to === joinNodeId) {
      return { kind: "output", output: result.output };
    }

    // Advance to the next step in this branch.
    currentNode = thenEdge.to;
    currentInput = result.output;
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
    // Resolve the convergence node before spawning branches — findJoinNode
    // validates linearity (no nested fan-out) and that all branches share a
    // single common join, replacing the old per-branch joinEdge lookup.
    const joinNodeId = findJoinNode(branchTargets, nodeId, flow);
    const results: BranchResult[] = await Promise.all(
      branchTargets.map((branch: NodeId) =>
        runBranch(
          branch,
          applyThreadAction(thread, "fork", undefined),
          flow,
          runtime,
          emit.output,
          attemptsByNode,
          joinNodeId,
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

    // Validate JoinStep tagging: a join()-tagged step must receive multiple
    // inputs (from fan-out pendingInputs). Running one with a single input
    // means it was wired as a plain step, which is a mistake the author
    // should catch at run time rather than silently get wrong results.
    if ((node.run as { join?: boolean }).join === true && inputs.length < 2) {
      throw new Error(
        `node "${current}" is tagged with join() but was reached as a plain step — ` +
          `it must be the convergence point of a fan-out`,
      );
    }
    if ((node.run as { join?: boolean }).join !== true && inputs.length >= 2) {
      throw new Error(
        `node "${current}" is the convergence point of a fan-out but was not defined with join() — ` +
          `wrap its step with join(...) to declare it expects every branch's output`,
      );
    }

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
 * @public
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

/** One cursor's current state within a tick() outcome — node, status, and (for parked) what it's waiting for. */
export interface CursorState {
  node: NodeId;
  status: "active" | "parked" | "done";
  waitingFor?: MessageKind[]; // present only when status is "parked"
  result?: unknown; // present only when status is "done" (root cursor only)
  parent?: string; // absent = this is the root cursor; present = identifies which cursor this folds into
}

/** One tick()'s outcome: a set of independently-progressing cursors. For single-cursor flows, always a one-element array. */
export type TickOutcome = CursorState[];

/**
 * One fan-out branch's reconstructed progress inside an in-flight group.
 * `thread` is set once the branch has actually run its first node (forked
 * off the group's `mainThread`, same as `runBranch` forks per branch for
 * `runFlow`) — absent while the branch hasn't been picked yet. `current` is
 * the node this branch will run next; once `done`, it stays at the last
 * chain node the branch actually ran, and `output` holds what it reported
 * to the join.
 */
interface BranchReplay {
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
interface FanOutGroup {
  fanOutNodeId: NodeId;
  joinNodeId: NodeId;
  mainThread: Thread;
  branches: BranchReplay[];
}

/** One level of a replayed `tick()` position — the outermost flow, or a `use` node's subgraph descended into it. `useNodeId` is the id, in the ENCLOSING frame's own flow, of the `use` node whose subgraph this frame reconstructs; absent only for the outermost (root) frame — which is also why it doubles as the `parent` a nested cursor reports. */
interface ReplayFrame {
  flow: Graph;
  useNodeId?: NodeId;
  current: NodeId;
  currentInput: unknown;
  // The edge-resolved prompt (if any) that led to `current` — what a `use`
  // node reached next would seed its subgraph with. Mirrors driveGraph's
  // own `reason` variable, reconstructed the same way from replay.
  reason?: Message | undefined;
}

/** Where a fresh replay of `runtime.store`'s committed events left off: the frame stack — outermost flow first, innermost active `use` descent last — plus the thread they all share (a `use` node's subgraph never forks it) and any pending fan-out join inputs. */
interface ReplayPosition {
  thread: Thread;
  frames: ReplayFrame[];
  // Set only when replay landed on a join node whose fan-out group just
  // folded (every branch reported) — one entry per branch, in declared
  // order, mirroring driveStepEmit's own `pendingInputs`. Fan-out is only
  // ever reconstructed at the outermost frame — see `advanceFanOutGroup`.
  pendingInputs?: unknown[];
}

/** What a fresh replay of `runtime.store` left off at: mid-flight on one line (`single`), or spread across an in-flight fan-out group's branches (`fanout`). */
type ReplayResult = ({ kind: "single" } & ReplayPosition) | { kind: "fanout"; group: FanOutGroup };

/** A fan-out group's branches all reporting collapses cursor-tracking back to one line: the join node, fed every branch's output in declared order. `undefined` while any branch is still in flight. */
function foldGroup(group: FanOutGroup): { current: NodeId; pendingInputs: unknown[] } | undefined {
  if (!group.branches.every((branch) => branch.done)) return undefined;
  return {
    current: group.joinNodeId,
    pendingInputs: group.branches.map((branch) => branch.output),
  };
}

/** Reconstructs a forked branch thread from its observed thread id — an approximation of `applyThreadAction(mainThread, "fork", ...)` sufficient for a branch, which (like `runBranch`) never runs a node that folds a further message into its thread. */
function replayForkedThread(mainThread: Thread, threadId: ThreadId): Thread {
  return {
    id: threadId,
    forkedFrom: { thread: mainThread.id, at: mainThread.history.length },
    messages: [...mainThread.messages],
    history: [...mainThread.history],
  };
}

/** Folds one committed output event into whichever branch of `group` it belongs to — identified by the event's thread id once known, or by its stepId matching a not-yet-started branch's own target the first time that branch's thread appears in the log. */
function replayBranchOutput(
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

  if (thenEdge.to === group.joinNodeId) {
    branch.done = true;
    branch.output = value;
    branch.current = stepId;
  } else {
    branch.current = thenEdge.to;
    branch.currentInput = value;
  }
}

/**
 * Reconstructs `tick`'s position purely from `runtime.store.events()` — no
 * state survives anywhere else. Starts at `flow.entry` with a fresh thread
 * when the log is empty, then replays every committed `output` (a step ran;
 * follow the edge its value selects, same as `advance`) and `message` (a
 * `waitFor` consumed one, or a `use` node's subgraph was seeded; follow *its*
 * edge, or descend into it, the same way) event in order, landing exactly
 * where the last tick call left off. A fan-out node's own output event
 * switches this into per-branch reconstruction (`FanOutGroup`) until either
 * every branch has reported (folding back to a single position at the join
 * node, `pendingInputs` set) or the join node's own output event shows the
 * fold already ran on an earlier tick call — the log-level signal to resume
 * ordinary single-line replay from there. Fan-out is only ever reconstructed
 * at the outermost frame — a fan-out inside a used subgraph is
 * notImplemented, matching tick()'s own live handling.
 *
 * A `use` node's subgraph shares its parent's thread (never forked), so
 * thread identity says nothing about whether a given event belongs to the
 * outer flow or a nested descent — only the event's own node id does. Every
 * node across every graph gets a globally unique id (see flow/graph.ts's
 * `freshNodeId`), so an output event's `stepId` belongs to exactly one
 * frame; the frame stack mirrors the `use` descents a live tick() call would
 * have made: pushed the moment a `message` event seeds a `use` node's
 * subgraph, popped the moment an output event turns up whose id belongs to
 * an enclosing frame instead — the completion event `commitOutput` tags with
 * the `use` node's own (outer) id once its subgraph reaches `finish`.
 */
function replayPosition(flow: Graph, store: SessionStore): ReplayResult {
  let thread: Thread = { id: freshThreadId(), messages: [], history: [] };
  let group: FanOutGroup | undefined;
  const frames: ReplayFrame[] = [{ flow, current: flow.entry, currentInput: undefined }];
  const root = frames[0];
  if (!root) unreachable("replayPosition: frame stack starts empty");

  for (const envelope of store.events()) {
    if (envelope.form !== "committed") continue;

    if (group) {
      if (envelope.type === "output") {
        const { value } = envelope.event as Event["output"];
        const stepId = envelope.stepId as NodeId;
        if (stepId === group.joinNodeId) {
          // The join already ran on an earlier tick call: the group folded
          // in the log itself. Resume ordinary single-line replay from here.
          thread = group.mainThread;
          const edge = advance(flow.edges, stepId, value);
          const followed = follow(edge, thread);
          thread = followed.thread;
          root.current = followed.to;
          root.currentInput = value;
          root.reason = edge.reason;
          group = undefined;
        } else {
          replayBranchOutput(group, envelope.threadId, stepId, value, flow);
        }
      }
      // toolCall/toolResult/compaction/invalidation/error/message inside a
      // branch aren't produced by any node kind `runBranchNode` supports —
      // out of scope for this slice's replay, same as the single-line path.
      continue;
    }

    if (envelope.threadId) thread = { ...thread, id: envelope.threadId };

    if (envelope.type === "output") {
      const { value } = envelope.event as Event["output"];
      const stepId = envelope.stepId as NodeId;

      // Find the frame that actually owns this node id, from the innermost
      // frame outward. Node ids are globally unique per graph, so exactly
      // one frame ever recognizes a given id; landing on an ENCLOSING
      // frame's own id (rather than the innermost one's) means every frame
      // above it already reached its own `finish` — each logged its own
      // such completion event first — so truncating the stack back to that
      // depth is simply catching up on pops a live tick() call already made.
      let owner: ReplayFrame | undefined;
      let depth = frames.length - 1;
      for (; depth >= 0; depth -= 1) {
        const candidate = frames[depth];
        if (candidate?.flow.nodes.has(stepId)) {
          owner = candidate;
          break;
        }
      }
      if (!owner) continue; // inner noise no known frame owns — skip
      frames.length = depth + 1;
      const top = owner;

      const branchTargets = thenEdges(top.flow.edges, stepId).map((edge) => edge.to);
      if (branchTargets.length > 1) {
        if (depth > 0) notImplemented("tick: fan-out inside a used subgraph");
        // A fan-out node's own output: hand off to per-branch reconstruction
        // instead of `advance`, which would silently pick just the first
        // branch (see `selectEdge`) and desync from what actually ran.
        group = {
          fanOutNodeId: stepId,
          joinNodeId: findJoinNode(branchTargets, stepId, top.flow),
          mainThread: thread,
          branches: branchTargets.map((target) => ({
            target,
            current: target,
            currentInput: value,
            started: false,
            done: false,
          })),
        };
        continue;
      }

      const edge = advance(top.flow.edges, stepId, value);
      const followed = follow(edge, thread);
      thread = followed.thread;
      top.current = followed.to;
      top.currentInput = value;
      top.reason = edge.reason;
      continue;
    }

    if (envelope.type === "message") {
      const { message } = envelope.event as Event["message"];
      const top = frames[frames.length - 1];
      if (!top) unreachable("replayPosition: frame stack is empty");
      const node = top.flow.nodes.get(top.current);

      if (node?.kind === "waitFor") {
        pushMessage(thread, message);
        const edge = advance(top.flow.edges, top.current, message);
        const followed = follow(edge, thread);
        thread = followed.thread;
        top.current = followed.to;
        top.currentInput = { ok: true } satisfies WaitForResult;
        top.reason = edge.reason;
        continue;
      }

      if (node?.kind === "use") {
        // Entering this use node's subgraph: mirrors driveUseNode's own seed
        // dedup (a "same"-threadAction reaching edge already pushed this
        // message onto the thread; this event just echoes it into the log)
        // and descends a frame at the subgraph's own entry, seeded with this
        // exact message — the same value `driveGraph`'s own `input`
        // parameter would carry.
        if (!top.reason) pushMessage(thread, message);
        frames.push({
          flow: node.subgraph,
          useNodeId: top.current,
          current: node.subgraph.entry,
          currentInput: message,
        });
        continue;
      }

      // Belongs to a node this replay isn't tracking as any frame's
      // `current` — safe to skip; it never needs to move a frame's position.
      continue;
    }
    // toolCall/toolResult/compaction/invalidation/error don't move the main
    // position on their own — out of scope for this slice's replay.
  }

  if (group) {
    const folded = foldGroup(group);
    if (folded) {
      return {
        kind: "single",
        thread: group.mainThread,
        frames: [{ flow, current: folded.current, currentInput: undefined }],
        pendingInputs: folded.pendingInputs,
      };
    }
    return { kind: "fanout", group };
  }

  return { kind: "single", thread, frames };
}

/** One branch cursor's outward `CursorState` — `parked` (not `done`, reserved for the root) once it has folded its own output in, `active` while it still has work of its own left. */
function branchCursorState(branch: BranchReplay, group: FanOutGroup): CursorState {
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
async function advanceFanOutGroup(
  group: FanOutGroup,
  flow: Graph,
  runtime: Runtime,
  attemptsByNode: Map<NodeId, number>,
): Promise<TickOutcome> {
  const branch = group.branches.find((candidate) => !candidate.done);
  if (!branch) unreachable("advanceFanOutGroup: no unfinished branch in a fan-out group");

  branch.thread ??= applyThreadAction(group.mainThread, "fork", undefined);
  let branchThread = branch.thread;
  const nodeDef = flow.nodes.get(branch.current);
  if (nodeDef?.kind === "step" && nodeDef.label)
    branchThread = { ...branchThread, label: nodeDef.label };
  branch.thread = branchThread;

  const result = await runBranchNode(
    branch.current,
    branchThread,
    flow,
    runtime,
    branch.currentInput,
    attemptsByNode,
  );
  if (result.kind === "invalidate") notImplemented("tick: fan-out branch invalidate");

  const thenEdge = flow.edges.find((edge) => edge.from === branch.current && edge.edge === "then");
  if (!thenEdge)
    throw new Error(`fan-out branch step "${branch.current}" has no outgoing then edge`);

  if (thenEdge.to === group.joinNodeId) {
    branch.done = true;
    branch.output = result.output;
  } else {
    branch.current = thenEdge.to;
    branch.currentInput = result.output;
  }

  const folded = foldGroup(group);
  if (folded) return [{ node: folded.current, status: "active" }];
  return group.branches.map((candidate) => branchCursorState(candidate, group));
}

/** One frame of tick()'s live execution — same shape as a `ReplayFrame`, plus what only matters while actually running: this frame's own armed interrupts (recomputed per level, same as `driveGraph` does for every nested `driveGraph` call) and the `StepContext` its own nodes run with. */
interface LiveFrame {
  flow: Graph;
  useNodeId?: NodeId;
  interrupts: InterruptNode[];
  current: NodeId;
  currentInput: unknown;
  reason?: Message | undefined;
  context: StepContext;
}

/** Builds a `LiveFrame` from a replayed one, wiring its `StepContext` to read this exact frame's own (mutable) `current` through a closure — so a later push/pop only ever touches the frame objects themselves, never anything `buildDriveContext` captured. */
function buildLiveFrame(
  replayFrame: ReplayFrame,
  runtime: Runtime,
  getThread: () => Thread,
): LiveFrame {
  const frame = {
    flow: replayFrame.flow,
    useNodeId: replayFrame.useNodeId,
    interrupts: findInterruptNodes(replayFrame.flow),
    current: replayFrame.current,
    currentInput: replayFrame.currentInput,
    reason: replayFrame.reason,
  } as LiveFrame;
  frame.context = buildDriveContext(frame.flow, runtime, () => frame.current, getThread);
  return frame;
}

/**
 * Advances a flow exactly one node, reconstructing where it is purely from
 * `runtime.store` — no state may survive in a JS closure between calls, so a
 * fresh `Runtime` object (same store) resumes exactly like the original one.
 *
 * A `waitFor` that already has a matching message waiting is “free”: it’s
 * consumed and its edge followed inline, without counting as this tick’s one
 * step — so resuming at a `waitFor` and reaching `finish` in the same call
 * (no work left to run in between) reports `done`, not `advanced`.
 *
 * A fan-out node's branches advance one at a time across separate `tick`
 * calls instead of running every branch to completion in one `Promise.all`
 * like `runFlow` does — see `advanceFanOutGroup`.
 *
 * A `use` node is driven the same way tick() drives its own top-level graph:
 * one node at a time, on a child frame pushed onto a stack (not forked —
 * `use` shares its parent's thread, unlike a fan-out branch). Reaching the
 * subgraph's own `finish` pops that frame and folds its result into the
 * enclosing one, exactly like `driveUseNode`'s own tail; parking on the
 * subgraph's own `waitFor` reports a cursor whose `parent` is the `use`
 * node's id, mirroring how a fan-out branch's cursor reports the fan-out
 * node as its parent.
 */
export async function tick(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  const attemptsByNode = new Map<NodeId, number>();
  const position = replayPosition(flow, runtime.store);

  if (position.kind === "fanout") {
    return advanceFanOutGroup(position.group, flow, runtime, attemptsByNode);
  }

  let currentThread: Thread = position.thread;
  let pendingInputs: unknown[] | undefined = position.pendingInputs;
  let ranStep = false;

  const getThread = (): Thread => currentThread;
  const frames: LiveFrame[] = position.frames.map((replayFrame) =>
    buildLiveFrame(replayFrame, runtime, getThread),
  );

  for (;;) {
    const frame = frames[frames.length - 1];
    if (!frame) unreachable("tick: frame stack is empty");
    const node = frame.flow.nodes.get(frame.current);
    if (!node) throw new Error(`graph "${frame.flow.name}" has no node "${frame.current}"`);
    const parent = frame.useNodeId !== undefined ? { parent: frame.useNodeId } : {};

    if (node.kind === "finish") {
      if (frames.length === 1) {
        return [{ node: frame.current, status: "done", result: frame.currentInput }];
      }
      // Pop: fold this frame's terminal value back into the enclosing one,
      // exactly like driveUseNode's own tail — a single output event tagged
      // with the *outer* use node's id, then follow its edge.
      const finished = frame;
      frames.pop();
      const below = frames[frames.length - 1];
      const useNodeId = finished.useNodeId;
      if (!below || useNodeId === undefined)
        unreachable("tick: popped frame missing its enclosing use-node id");
      const edge = commitOutput(
        runtime,
        currentThread.id,
        below.flow.edges,
        useNodeId,
        finished.currentInput,
        stepIdentity(useNodeId),
      );
      const followed = follow(edge, currentThread);
      currentThread = followed.thread;
      below.current = followed.to;
      below.currentInput = finished.currentInput;
      below.reason = edge.reason;
      continue;
    }

    if (node.kind === "waitFor") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];
      const kinds = [
        node.messageKind,
        ...frame.interrupts.map((interrupt) => interrupt.messageKind),
      ];
      const message = runtime.store.consume(
        (candidate) => candidate.kind !== undefined && kinds.includes(candidate.kind),
      );
      if (!message)
        return [{ node: frame.current, status: "parked", waitingFor: kinds, ...parent }];

      runtime.store.append({ message }, { type: "message", threadId: currentThread.id });
      pushMessage(currentThread, message);

      const interrupt = frame.interrupts.find(
        (candidate) => candidate.messageKind === message.kind,
      );
      if (interrupt) {
        const stepContext: StepContext = { ...frame.context, inputs: [message] };
        const emit = await runStep(interrupt.run, stepContext);
        if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
        const edge = commitOutput(
          runtime,
          currentThread.id,
          frame.flow.edges,
          interrupt.id,
          emit.output,
          {
            stepId: interrupt.id,
          },
        );
        const followed = follow(edge, currentThread);
        currentThread = followed.thread;
        frame.current = followed.to;
        frame.currentInput = emit.output;
        ranStep = true;
        frame.reason = edge.reason;
      } else {
        const edge = advance(frame.flow.edges, frame.current, message);
        const followed = follow(edge, currentThread);
        currentThread = followed.thread;
        frame.current = followed.to;
        frame.currentInput = { ok: true } satisfies WaitForResult;
        frame.reason = edge.reason;
      }
      continue;
    }

    if (node.kind === "use") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];

      // The subgraph's initial prompt — same seed rule as driveUseNode's own
      // (the reaching edge's prompt, a real Message reaching this node
      // directly, or the thread's last message as fallback) — logged once
      // here the same way regardless of which of those it came from.
      const fallback: Message | undefined = currentThread.messages.at(-1);
      const seed: Message | undefined =
        frame.reason ?? (looksLikeMessage(frame.currentInput) ? frame.currentInput : fallback);
      if (!seed) throw new Error("use node has no message to seed its subgraph with");
      if (!frame.reason) pushMessage(currentThread, seed);
      runtime.store.append({ message: seed }, { type: "message", threadId: currentThread.id });

      frames.push(
        buildLiveFrame(
          {
            flow: node.subgraph,
            useNodeId: frame.current,
            current: node.subgraph.entry,
            currentInput: seed,
          },
          runtime,
          getThread,
        ),
      );
      continue;
    }

    if (node.kind !== "step") notImplemented(`tick: node kind "${node.kind}"`);

    if (ranStep) return [{ node: frame.current, status: "active", ...parent }];

    if (node.label) currentThread = { ...currentThread, label: node.label };

    const inputs = pendingInputs ?? [frame.currentInput];
    pendingInputs = undefined;

    // Validate JoinStep tagging the same way driveGraph does for runFlow —
    // a join()-tagged node reached with a single input, or a converging
    // node not tagged with join(), is a wiring mistake worth catching here
    // too, not only when driven through runFlow.
    if ((node.run as { join?: boolean }).join === true && inputs.length < 2) {
      throw new Error(
        `node "${frame.current}" is tagged with join() but was reached as a plain step — ` +
          `it must be the convergence point of a fan-out`,
      );
    }
    if ((node.run as { join?: boolean }).join !== true && inputs.length >= 2) {
      throw new Error(
        `node "${frame.current}" is the convergence point of a fan-out but was not defined with join() — ` +
          `wrap its step with join(...) to declare it expects every branch's output`,
      );
    }

    const stepContext: StepContext = { ...frame.context, inputs };
    const emit = await runStep(node.run, stepContext);

    if ("output" in emit) {
      const branchTargets = thenEdges(frame.flow.edges, frame.current).map((edge) => edge.to);
      if (branchTargets.length > 1) {
        // Same detection driveStepEmit uses, but tick spawns per-branch
        // cursors instead of running every branch to completion in one
        // Promise.all — see advanceFanOutGroup. Only ever reconstructed at
        // the outermost frame — see replayPosition's own matching guard.
        if (frames.length > 1) notImplemented("tick: fan-out inside a used subgraph");
        appendOutput(
          runtime,
          currentThread.id,
          emit.output,
          stepIdentity(frame.current, node.label),
        );
        const group: FanOutGroup = {
          fanOutNodeId: frame.current,
          joinNodeId: findJoinNode(branchTargets, frame.current, frame.flow),
          mainThread: currentThread,
          branches: branchTargets.map((target) => ({
            target,
            current: target,
            currentInput: emit.output,
            started: false,
            done: false,
          })),
        };
        return group.branches.map((branch) => branchCursorState(branch, group));
      }
    }

    const outcome = await driveStepEmit(
      emit,
      node,
      frame.current,
      currentThread,
      frame.flow,
      runtime,
      attemptsByNode,
    );

    if (outcome.kind === "retry") continue;
    if (outcome.pendingInputs)
      unreachable("tick: driveStepEmit reported a fan-out after tick's own check ruled it out");

    currentThread = outcome.thread;
    frame.currentInput = outcome.input;
    frame.reason = outcome.reason;
    frame.current = outcome.to;
    ranStep = true;
  }
}

/** Calls `tick` until it stops advancing — every cursor either parked or done. */
export async function tickUntilSuspended(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  for (;;) {
    const outcome = await tick(flow, runtime);
    if (outcome.every((cursor) => cursor.status !== "active")) return outcome;
  }
}
