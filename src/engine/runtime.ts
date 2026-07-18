// Systems running flows — runtime / runFlow. See docs/reference.md.

import type { Model } from "../flow/model.js";
import type { Message } from "../flow/message.js";
import type { Graph, NodeId } from "../flow/graph.js";
import type { Binding } from "../flow/tool.js";
import type { ThreadId } from "../flow/thread.js";
import type { StepContext, Emit, ModelCallResult, StepError } from "../flow/step.js";
import type { Tool } from "../flow/tool.js";
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
 * Seeds a new session with a user message, drives it to completion, and
 * resolves with the terminal output. A `parentThreadId` makes it a child —
 * how a tool spawns a sub-agent.
 */
export async function runFlow(
  flow: Graph,
  initialPrompt: Message,
  _runtime: Runtime,
  options?: { parentThreadId?: ThreadId },
): Promise<unknown> {
  const threadId = "thread-0" as ThreadId;

  const context: StepContext = {
    thread: {
      id: threadId,
      ...(options?.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
      messages: [initialPrompt],
      history: [initialPrompt],
    },
    inputs: [],
    stream: { delta: () => notImplemented("stream") },

    modelCall(): Promise<ModelCallResult> {
      return notImplemented("modelCall");
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
    invalidate(): Emit<never> {
      return notImplemented("invalidate");
    },
    fail(error: StepError): Emit<never> {
      return notImplemented("fail: " + error.message);
    },
  };

  let current: NodeId | undefined = flow.entry;
  let input: unknown = initialPrompt;

  while (current) {
    const node = flow.nodes.get(current);
    if (!node) throw new Error(`graph "${flow.name}" has no node "${current}"`);

    if (node.kind === "finish") return input;

    if (node.kind !== "step") notImplemented(`node kind "${node.kind}"`);

    const stepContext: StepContext = { ...context, inputs: [input] };
    const emit = await node.run(stepContext);
    if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
    input = emit.output;

    const edge = flow.edges.find((candidate) => candidate.from === current);
    if (!edge) throw new Error(`node "${current}" has no outgoing edge`);
    current = edge.to;
  }

  return input;
}
