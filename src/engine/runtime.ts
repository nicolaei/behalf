// Systems running flows — runtime / runFlow. See docs/reference.md.

import type { Model } from "../flow/model.js";
import type { Message, MessageKind, UserMessage, AssistantMessage } from "../flow/message.js";
import type { Graph, NodeId, EdgeDefinition } from "../flow/graph.js";
import type { Binding } from "../flow/tool.js";
import type { ThreadId, ThreadAction } from "../flow/thread.js";
import type { StepContext, Emit, ModelCallResult, StepError, Step } from "../flow/step.js";
import type { Tool, ToolContext } from "../flow/tool.js";
import type { DeltaSink } from "../session/envelope.js";
import type { Profile } from "../flow/profile.js";
import type { ContentBlock } from "../flow/message.js";
import type { ModelPort } from "./model-port.js";
import type { SessionStore } from "./session-store.js";
import type { ErrorContext, ErrorDecision, ErrorHandler } from "./errors.js";

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

function notImplemented(name: string): never {
  throw new Error(`${name} is not implemented yet`);
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

/** Appends a node's output event to the log — shared by every path that produces one. */
function appendOutput(runtime: Runtime, threadId: ThreadId, output: unknown): void {
  runtime.store.append({ value: output }, { type: "output", threadId });
}

/** Logs a step's output and follows the resulting edge — the shared tail of every node that emits one. */
function commitOutput(
  runtime: Runtime,
  threadId: ThreadId,
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
): Advance {
  appendOutput(runtime, threadId, output);
  return advance(edges, from, output);
}

/** Applies an edge's threadAction and reports where it leads — the shared tail of following any edge. */
function follow(edge: Advance, thread: Thread): { thread: Thread; to: NodeId } {
  return { thread: applyThreadAction(thread, edge.threadAction, edge.reason), to: edge.to };
}

/**
 * Parks until the inbox has a message of the given kind, polling on a
 * timer tick so a synchronous `store.submit()` racing this call — before
 * or after it starts — is never missed.
 */
async function waitForMessage(
  store: SessionStore,
  kinds: readonly MessageKind[],
): Promise<UserMessage> {
  for (;;) {
    const message = store.consume(
      (candidate) => candidate.kind !== undefined && kinds.includes(candidate.kind),
    );
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Parks until an abort message reaches the inbox — same polling shape as `waitForMessage`. */
async function waitForAbort(store: SessionStore): Promise<UserMessage> {
  for (;;) {
    const message = store.consume((candidate) => candidate.intent === "abort");
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
  context.thread.messages.push(toolMessage);
  context.thread.history.push(toolMessage);
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
): Promise<ModelCallResult> {
  const port = runtime.models(profile.model);
  const stream = runtime.store.open({
    correlationId: freshCorrelationId(),
    type: "message",
    stepId: freshStepId(),
    threadId: context.thread.id,
  });

  const outcome = await Promise.race([
    port
      .respond(profile, context.thread.messages, stream)
      .then((message): { kind: "reply"; message: AssistantMessage } => ({
        kind: "reply",
        message,
      })),
    waitForAbort(runtime.store).then((): { kind: "abort" } => ({ kind: "abort" })),
  ]);

  if (outcome.kind === "abort") {
    stream.abort();
    throw new Error("model call aborted");
  }

  const { message: reply } = outcome;
  stream.commit({ message: reply });
  context.thread.messages.push(reply);
  context.thread.history.push(reply);

  const toolCalls = reply.content.filter(isToolCall);
  for (const call of toolCalls) {
    await runToolCall(call, context, runtime);
  }

  return { usedTools: toolCalls.length > 0, usage: reply.usage };
}

let nextStepId = 0;
function freshStepId(): string {
  nextStepId += 1;
  return `step-${String(nextStepId)}`;
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
    if (reason) {
      messages.push(reason);
      history.push(reason);
    }
    return {
      id: freshThreadId(),
      forkedFrom: { thread: current.id, at: current.history.length },
      messages,
      history,
    };
  }

  // "same": no new thread — push the reason onto the one already running.
  if (reason) {
    current.messages.push(reason);
    current.history.push(reason);
  }
  return current;
}

/** The `then` edges leaving a node, in declared order — more than one means a fan-out. */
function thenEdges(edges: readonly EdgeDefinition[], from: NodeId): EdgeDefinition[] {
  return edges.filter((candidate) => candidate.from === from && candidate.edge === "then");
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
  if (nodeDef.kind !== "step") notImplemented(`fan-out branch node kind "${nodeDef.kind}"`);
  if (nodeDef.label) branchThread = { ...branchThread, label: nodeDef.label };

  const branchContext: StepContext = {
    get thread() {
      return branchThread;
    },
    inputs: [input],
    stream: { delta: () => notImplemented("stream") },

    modelCall(profile): Promise<ModelCallResult> {
      return runModelCall(profile, branchContext, runtime);
    },
    call<Input, Output>(tool: Tool<Input, Output>, toolInput: Input): Promise<Output> {
      void tool;
      void toolInput;
      return notImplemented("call");
    },

    output<Result>(value: Result): Emit<Result> {
      return { output: value };
    },
    compact(): Promise<Emit<Message[]>> {
      return notImplemented("compact in a fan-out branch");
    },
    invalidate(): Emit<never> {
      return notImplemented("invalidate in a fan-out branch");
    },
    fail(error: StepError): Emit<never> {
      return { error };
    },
  };

  const emit = await runStep(nodeDef.run, branchContext);
  if (!("output" in emit)) {
    notImplemented(`emit "${Object.keys(emit).join(", ")}" in a fan-out branch`);
  }

  appendOutput(runtime, branchThread.id, emit.output);

  const joinEdge = flow.edges.find((edge) => edge.from === node && edge.edge === "join");
  if (!joinEdge) throw new Error(`fan-out branch "${node}" has no join edge`);

  return { output: emit.output, joinTo: joinEdge.to };
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

  const context: StepContext = {
    get thread() {
      return currentThread;
    },
    inputs: [],
    stream: { delta: () => notImplemented("stream") },

    modelCall(profile): Promise<ModelCallResult> {
      return runModelCall(profile, context, runtime);
    },
    call<Input, Output>(tool: Tool<Input, Output>, input: Input): Promise<Output> {
      return callTool(tool, input, currentThread.id, context.stream, runtime);
    },

    output<Result>(value: Result): Emit<Result> {
      return { output: value };
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
    fail(error: StepError): Emit<never> {
      return { error };
    },
  };

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
      // The subgraph's initial prompt: the reaching edge's `prompt` output, if
      // it had one (the previous iteration's `follow` already pushed it onto
      // this thread; logged again here so it lands in the log too), otherwise
      // the raw incoming value, trusted to already be a `Message` (never
      // pushed onto the thread, so push it now — this node is its only source).
      const seed: Message = reason ?? (currentInput as Message);
      if (!reason) {
        currentThread.messages.push(seed);
        currentThread.history.push(seed);
      }
      runtime.store.append({ message: seed }, { type: "message", threadId: currentThread.id });

      const result = await driveGraph(node.subgraph, runtime, currentThread, seed);
      currentThread = result.thread;
      currentInput = result.output;

      const edge = commitOutput(runtime, currentThread.id, flow.edges, current, result.output);
      reason = edge.reason;
      ({ thread: currentThread, to: current } = follow(edge, currentThread));
      continue;
    }

    if (node.kind === "waitFor") {
      const message = await waitForMessage(runtime.store, [
        node.messageKind,
        ...interrupts.map((interrupt) => interrupt.messageKind),
      ]);

      // Consuming the message is the same step regardless of who it's for:
      // it becomes a log event and joins the thread, then whichever node was
      // actually armed for its kind — the interrupt, or this waitFor itself —
      // runs and takes over routing.
      runtime.store.append({ message }, { type: "message", threadId: currentThread.id });
      currentThread.messages.push(message);
      currentThread.history.push(message);
      currentInput = message;

      const interrupt = interrupts.find((candidate) => candidate.messageKind === message.kind);
      if (interrupt) {
        const stepContext: StepContext = { ...context, inputs: [message] };
        const emit = await runStep(interrupt.run, stepContext);
        if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
        currentInput = emit.output;
        const edge = commitOutput(runtime, currentThread.id, flow.edges, interrupt.id, emit.output);
        reason = edge.reason;
        ({ thread: currentThread, to: current } = follow(edge, currentThread));
        continue;
      }

      const edge = advance(flow.edges, current, currentInput);
      reason = edge.reason;
      ({ thread: currentThread, to: current } = follow(edge, currentThread));
      continue;
    }

    if (node.kind !== "step") notImplemented(`node kind "${node.kind}"`);

    if (node.label) currentThread = { ...currentThread, label: node.label };

    const stepContext: StepContext = { ...context, inputs };
    const emit = await runStep(node.run, stepContext);

    if ("invalidate" in emit) {
      const invalidatedThreadId = currentThread.id;
      currentThread = applyThreadAction(currentThread, emit.threadAction, emit.reason);
      runtime.store.append(
        {
          target: emit.invalidate,
          threadAction: emit.threadAction,
          ...(emit.reason ? { reason: emit.reason } : {}),
        },
        { type: "invalidation", threadId: invalidatedThreadId },
      );
      current = emit.invalidate;
      currentInput = undefined;
      reason = undefined;
      continue;
    }

    if ("compact" in emit) {
      runtime.store.append(
        { messages: emit.compact, ...(emit.meta !== undefined ? { meta: emit.meta } : {}) },
        { type: "compaction", threadId: currentThread.id },
      );
      currentThread.messages = emit.compact;
      currentThread.history.push(...emit.compact);
      currentInput = undefined;
      const edge = advance(flow.edges, current, undefined);
      reason = edge.reason;
      ({ thread: currentThread, to: current } = follow(edge, currentThread));
      continue;
    }

    if ("error" in emit) {
      runtime.store.append(
        {
          type: emit.error.type,
          message: emit.error.message,
          ...(emit.error.retryable !== undefined ? { retryable: emit.error.retryable } : {}),
          ...(emit.error.cause !== undefined ? { cause: emit.error.cause } : {}),
        },
        { type: "error", threadId: currentThread.id },
      );

      const attempts = attemptsByNode.get(current) ?? 0;
      const errorContext: ErrorContext = {
        step: { id: current },
        thread: currentThread.id,
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

      attemptsByNode.set(current, attempts + 1);
      if (decision.after) await new Promise((resolve) => setTimeout(resolve, decision.after));
      continue;
    }

    if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);

    const branchTargets: NodeId[] = thenEdges(flow.edges, current).map((edge) => edge.to);
    if (branchTargets.length > 1) {
      appendOutput(runtime, currentThread.id, emit.output);
      const results: { output: unknown; joinTo: NodeId }[] = await Promise.all(
        branchTargets.map((branch: NodeId) =>
          runBranch(
            branch,
            applyThreadAction(currentThread, "fork", undefined),
            flow,
            runtime,
            emit.output,
          ),
        ),
      );
      const [firstBranch, ...restOfBranches] = results;
      if (!firstBranch) throw new Error(`fan-out from "${current}" produced no branches`);
      const joinTo = firstBranch.joinTo;
      const disagreement = restOfBranches.find((result) => result.joinTo !== joinTo);
      if (disagreement) {
        throw new Error(
          `fan-out from "${current}" has branches joining different nodes ("${joinTo}" vs "${disagreement.joinTo}")`,
        );
      }
      current = joinTo;
      pendingInputs = results.map((result: { output: unknown }) => result.output);
      currentInput = undefined;
      reason = undefined;
      continue;
    }

    currentInput = emit.output;
    const edge = commitOutput(runtime, currentThread.id, flow.edges, current, emit.output);
    reason = edge.reason;
    ({ thread: currentThread, to: current } = follow(edge, currentThread));
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
  const threadId = "thread-0" as ThreadId;
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
