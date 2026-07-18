// Systems running flows — runtime / runFlow. See docs/reference.md.

import type { Model } from "../flow/model.js";
import type { Message } from "../flow/message.js";
import type { Graph, NodeId, EdgeDefinition } from "../flow/graph.js";
import type { Binding } from "../flow/tool.js";
import type { ThreadId } from "../flow/thread.js";
import type { StepContext, Emit, ModelCallResult, StepError } from "../flow/step.js";
import type { Tool, ToolContext } from "../flow/tool.js";
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

  runtime.store.append({ message: initialPrompt }, { type: "message", threadId });

  const context: StepContext = {
    thread: {
      id: threadId,
      ...(options?.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
      messages: [initialPrompt],
      history: [initialPrompt],
    },
    inputs: [],
    stream: { delta: () => notImplemented("stream") },

    async modelCall(profile): Promise<ModelCallResult> {
      const port = runtime.models(profile.model);
      const reply = await port.respond(profile, context.thread.messages, context.stream);
      context.thread.messages.push(reply);
      context.thread.history.push(reply);
      runtime.store.append({ message: reply }, { type: "message", threadId: context.thread.id });

      const toolCalls = reply.content.filter(
        (block): block is Extract<ContentBlock, { type: "toolCall" }> => block.type === "toolCall",
      );

      for (const call of toolCalls) {
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

      return { usedTools: toolCalls.length > 0, usage: reply.usage };
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
    runtime.store.append({ value: emit.output }, { type: "output", threadId });

    const edge = selectEdge(flow.edges, current, input);
    if (!edge) throw new Error(`node "${current}" has no outgoing edge`);
    current = edge.to;
  }

  return input;
}
