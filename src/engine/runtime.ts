// Systems running flows — runtime / runFlow. See docs/reference.md.

import type { Model } from "../flow/model.js";
import type { Message, MessageKind, UserMessage } from "../flow/message.js";
import type { Graph, NodeId, EdgeDefinition } from "../flow/graph.js";
import type { Binding } from "../flow/tool.js";
import type { ThreadId, ThreadAction } from "../flow/thread.js";
import type { StepContext, Emit, ModelCallResult, StepError, Step } from "../flow/step.js";
import type { Tool, ToolContext } from "../flow/tool.js";
import type { Profile } from "../flow/profile.js";
import type { ContentBlock } from "../flow/message.js";
import type { ModelPort } from "./model-port.js";
import type { SessionStore } from "./session-store.js";
import type { ErrorHandler } from "./errors.js";

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

/** Follows the node's outgoing edge for the given output, or throws if it has none. */
function advance(edges: readonly EdgeDefinition[], from: NodeId, output: unknown): NodeId {
  const edge = selectEdge(edges, from, output);
  if (!edge) throw new Error(`node "${from}" has no outgoing edge`);
  return edge.to;
}

/** Logs a step's output and follows the resulting edge — the shared tail of every node that emits one. */
function commitOutput(
  runtime: Runtime,
  threadId: ThreadId,
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
): NodeId {
  runtime.store.append({ value: output }, { type: "output", threadId });
  return advance(edges, from, output);
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
  const binding = runtime.bindings.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === call.name,
  );
  if (binding?.kind !== "tool") {
    throw new Error(`no tool binding for "${call.name}"`);
  }

  runtime.store.append(
    { correlationId: call.correlationId, name: call.name, input: call.input },
    { type: "toolCall", threadId: context.thread.id },
  );

  const toolContext: ToolContext = {
    thread: context.thread.id,
    stream: context.stream,
    runFlow: (flow, initialPrompt) =>
      runFlow(flow, initialPrompt, runtime, { parentThreadId: context.thread.id }),
  };
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
  const reply = await port.respond(profile, context.thread.messages, context.stream);
  context.thread.messages.push(reply);
  context.thread.history.push(reply);
  runtime.store.append({ message: reply }, { type: "message", threadId: context.thread.id });

  const toolCalls = reply.content.filter(isToolCall);
  for (const call of toolCalls) {
    await runToolCall(call, context, runtime);
  }

  return { usedTools: toolCalls.length > 0, usage: reply.usage };
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

  // The live current thread — reassigned (not mutated) by `invalidate` when it
  // forks or resets. `context.thread` reads it through a getter so every
  // consumer (modelCall, tool calls, invalidate itself) sees the same,
  // up-to-date thread rather than a snapshot captured once at the top.
  let currentThread: Thread = {
    id: threadId,
    ...(options?.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
    messages: [initialPrompt],
    history: [initialPrompt],
  };

  runtime.store.append({ message: initialPrompt }, { type: "message", threadId: currentThread.id });

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
      void tool;
      void input;
      return notImplemented("call");
    },

    output<Result>(value: Result): Emit<Result> {
      return { output: value };
    },
    compact(): Emit<Message[]> {
      return notImplemented("compact");
    },
    invalidate(target, options): Emit<never> {
      return {
        invalidate: target,
        threadAction: options?.threadAction ?? "same",
        ...(options?.reason ? { reason: options.reason } : {}),
      };
    },
    fail(error: StepError): Emit<never> {
      return notImplemented("fail: " + error.message);
    },
  };

  const interrupts = findInterruptNodes(flow);
  let current: NodeId | undefined = flow.entry;
  let input: unknown = initialPrompt;

  while (current) {
    const node = flow.nodes.get(current);
    if (!node) throw new Error(`graph "${flow.name}" has no node "${current}"`);

    if (node.kind === "finish") return input;

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
      input = message;

      const interrupt = interrupts.find((candidate) => candidate.messageKind === message.kind);
      if (interrupt) {
        const stepContext: StepContext = { ...context, inputs: [message] };
        const emit = await interrupt.run(stepContext);
        if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
        input = emit.output;
        current = commitOutput(runtime, currentThread.id, flow.edges, interrupt.id, emit.output);
        continue;
      }

      current = advance(flow.edges, current, input);
      continue;
    }

    if (node.kind !== "step") notImplemented(`node kind "${node.kind}"`);

    const stepContext: StepContext = { ...context, inputs: [input] };
    const emit = await node.run(stepContext);

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
      input = undefined;
      continue;
    }

    if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
    input = emit.output;
    current = commitOutput(runtime, currentThread.id, flow.edges, current, emit.output);
  }

  return input;
}
