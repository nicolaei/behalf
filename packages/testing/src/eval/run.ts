// Eval core data shape — Run/foldRun. New to `packages/testing`: today's
// engine has no Run type and no foldRun — packages/testing's `stepOnce`/
// `stepUntilBlocked`/`stepUntil` return a different shape entirely (lane
// status snapshots, not a folded execution). Built fresh here, using the
// unmerged `testing-framework` branch's `src/testing/graph/run.ts` as a
// design reference only.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { Envelope, AssistantMessage, Message, ThreadId, NodeId, Usage } from "@behalf-js/core";

/** One tool call+result pair, matched by correlationId during folding (the id itself is discarded once paired — nothing downstream needs it). @public */
export interface ToolTrace {
  name: string;
  input: unknown;
  output: unknown;
  isError?: boolean;
  thread: ThreadId;
}

/** Nodes entered, in log order — one entry per committed step output. @public */
export type Traversal = { node: NodeId; name?: string; thread: ThreadId }[];

/** One node's visit — its input (approximated from the same thread's previous committed output; empty for a thread's first visit), its output, and which thread it ran on. @public */
export interface NodeVisit {
  node: NodeId;
  input: unknown[];
  output: unknown;
  thread: ThreadId;
}

/**
 * Every scorer reads a `Run`, folded from one flow execution's committed
 * event log. Produced by driving a synthesized one-step "agent" graph
 * (`agentGraph(profile)`) through `runFlow` — evals always run a case to
 * completion, they don't pause mid-flow.
 * @public
 */
export interface Run<World = unknown, Output = unknown> {
  output: Output;
  world: World;
  tools: ToolTrace[];
  traversal: Traversal;
  visits: NodeVisit[];
  usage: Usage;
  latency: number;
  threads: { id: ThreadId; label?: string }[];
  lastReply(thread?: string): AssistantMessage | undefined;
  messages(thread?: string): Message[];
}

type CommittedEnvelope = Extract<Envelope, { type: string }>;

function isCommitted(envelope: Envelope): envelope is CommittedEnvelope {
  return envelope.form === "committed";
}

/** Folds one flow execution's committed event log into a `Run`. */
export function foldRun<World = unknown, Output = unknown>(
  events: Envelope[],
  world: World,
  latency: number,
): Run<World, Output> {
  const committed = events.filter(isCommitted);

  const outputEnvelopes = committed.filter(
    (envelope): envelope is CommittedEnvelope & { type: "output"; event: { value: unknown } } =>
      envelope.type === "output",
  );
  const lastOutputValue = outputEnvelopes.at(-1)?.event.value;

  const stepEnvelopes = outputEnvelopes.filter(
    (envelope): envelope is typeof envelope & { stepId: string; threadId: ThreadId } =>
      envelope.stepId !== undefined && envelope.threadId !== undefined,
  );

  const threads: { id: ThreadId; label?: string }[] = [];
  const seenThreads = new Set<string>();
  for (const envelope of committed) {
    if (envelope.threadId !== undefined && !seenThreads.has(envelope.threadId)) {
      seenThreads.add(envelope.threadId);
      threads.push({ id: envelope.threadId });
    }
  }

  const tools: ToolTrace[] = [];
  const pendingCalls = new Map<string, { name: string; input: unknown; thread: ThreadId }>();
  for (const envelope of committed) {
    if (envelope.type === "toolCall" && envelope.threadId !== undefined) {
      const event = envelope.event as { correlationId: string; name: string; input: unknown };
      pendingCalls.set(event.correlationId, {
        name: event.name,
        input: event.input,
        thread: envelope.threadId,
      });
    } else if (envelope.type === "toolResult") {
      const event = envelope.event as {
        correlationId: string;
        output: unknown;
        isError?: boolean;
      };
      const call = pendingCalls.get(event.correlationId);
      if (call) {
        pendingCalls.delete(event.correlationId);
        tools.push({
          name: call.name,
          input: call.input,
          output: event.output,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          thread: call.thread,
        });
      }
    }
  }

  const traversal: Traversal = stepEnvelopes.map((envelope) => ({
    node: envelope.stepId as NodeId,
    thread: envelope.threadId,
    ...(envelope.stepName ? { name: envelope.stepName } : {}),
  }));

  const lastOutputByThread = new Map<string, unknown>();
  const visits: NodeVisit[] = stepEnvelopes.map((envelope) => {
    const prev = lastOutputByThread.get(envelope.threadId);
    const input = prev !== undefined ? [prev] : [];
    lastOutputByThread.set(envelope.threadId, envelope.event.value);
    return {
      node: envelope.stepId as NodeId,
      input,
      output: envelope.event.value,
      thread: envelope.threadId,
    };
  });

  const allMessages: Message[] = [];
  const messagesByThread = new Map<string, Message[]>();
  let lastAssistantOverall: AssistantMessage | undefined;
  const lastAssistantByThread = new Map<string, AssistantMessage>();
  const usage: Usage = { input: 0, output: 0 };
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let hasReasoning = false;
  let hasCacheRead = false;
  let hasCacheWrite = false;

  for (const envelope of committed) {
    if (envelope.type === "toolResult") {
      const event = envelope.event as { correlationId: string; output: unknown; isError?: boolean };
      const toolMessage: Message = {
        role: "tool",
        content: [
          {
            type: "toolResult",
            correlationId: event.correlationId,
            output: event.output,
            ...(event.isError !== undefined ? { isError: event.isError } : {}),
          },
        ],
      };
      allMessages.push(toolMessage);
      if (envelope.threadId !== undefined) {
        const list = messagesByThread.get(envelope.threadId) ?? [];
        list.push(toolMessage);
        messagesByThread.set(envelope.threadId, list);
      }
      continue;
    }
    if (envelope.type !== "message") continue;
    const event = envelope.event as { message: Message };
    const message = event.message;

    allMessages.push(message);
    if (envelope.threadId !== undefined) {
      const list = messagesByThread.get(envelope.threadId) ?? [];
      list.push(message);
      messagesByThread.set(envelope.threadId, list);
    }

    if (message.role !== "assistant") continue;
    lastAssistantOverall = message;
    if (envelope.threadId !== undefined) {
      lastAssistantByThread.set(envelope.threadId, message);
    }

    const messageUsage = message.usage;
    usage.input += messageUsage.input;
    usage.output += messageUsage.output;
    if (messageUsage.reasoning !== undefined) {
      hasReasoning = true;
      reasoning += messageUsage.reasoning;
    }
    if (messageUsage.cacheRead !== undefined) {
      hasCacheRead = true;
      cacheRead += messageUsage.cacheRead;
    }
    if (messageUsage.cacheWrite !== undefined) {
      hasCacheWrite = true;
      cacheWrite += messageUsage.cacheWrite;
    }
  }
  if (hasReasoning) usage.reasoning = reasoning;
  if (hasCacheRead) usage.cacheRead = cacheRead;
  if (hasCacheWrite) usage.cacheWrite = cacheWrite;

  const output = lastOutputValue as Output;

  return {
    output,
    world,
    tools,
    traversal,
    visits,
    usage,
    latency,
    threads,
    lastReply: (thread) =>
      thread === undefined ? lastAssistantOverall : lastAssistantByThread.get(thread),
    messages: (thread) =>
      thread === undefined ? allMessages : (messagesByThread.get(thread) ?? []),
  };
}
