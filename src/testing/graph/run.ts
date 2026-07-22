// Graph-test primitives — stepOnce/stepUntilBlocked/stepUntil folding a Run.
// Built directly on the existing low-level src/testing/index.ts primitives
// (same names, same StepResult-driving machinery over `tick()`) — this module
// just folds their result into a Run instead of a StepResult. No `input`
// parameter anywhere here: fake models/tools never read message content, so
// the empty thread `tick` already starts with is correct as-is.
//
// Stub only — see the epic's Story 1/2/3/6 architecture notes for the
// concrete behaviour each earns.

import type {
  Graph,
  NodeId,
  ThreadId,
  Message,
  AssistantMessage,
  Usage,
  Runtime,
} from "../../index.js";
import type { Envelope, CommittedEnvelope } from "../../session/envelope.js";
import type { Event } from "../../session/event.js";
import { stepUntilBlocked as lowLevelStepUntilBlocked } from "../index.js";
import type { StepResult } from "../index.js";

/** One tool call folded from a run's log — call, result, and where it happened. `node` is omitted: a tool call's toolCall/toolResult envelopes are thread-scoped only (via appendEvent), never tagged with the requesting step's id. @public */
export interface ToolTrace {
  name: string;
  input: unknown;
  output: unknown;
  isError?: boolean;
  thread: ThreadId;
}

/** The nodes a run entered, in log order. @public */
export type Traversal = { node: NodeId; name?: string; thread: ThreadId }[];

/** One node's visit — its input, its output, and which thread it ran on. @public */
export interface NodeVisit {
  node: NodeId;
  input: unknown[];
  output: unknown;
  thread: ThreadId;
}

/** The fold every assertion reads — one flow's log, folded into what a test asserts on. @public */
export interface Run<World = unknown, Output = unknown> {
  output: Output;
  world: World;
  tools: ToolTrace[];
  traversal: Traversal;
  visits: NodeVisit[];
  usage: Usage;
  latency: number;
  readonly threads: { id: ThreadId; label?: string }[];
  lastReply(thread?: ThreadId | string): AssistantMessage | undefined;
  messages(thread?: ThreadId | string): Message[];
}

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Folds a runtime's committed log + the fixture's world into a Run. @public */
export function foldRun<World, Output = unknown>(
  events: unknown[],
  world: World,
  latency: number,
): Run<World, Output> {
  const envelopes = events as Envelope[];
  const committed = envelopes.filter(
    (envelope): envelope is CommittedEnvelope => envelope.form === "committed",
  );
  const outputEvents = committed.filter(
    (envelope): envelope is CommittedEnvelope & { type: "output"; event: { value: unknown } } =>
      envelope.type === "output",
  );
  const lastOutput = outputEvents.at(-1);
  const output = lastOutput?.event.value as Output;

  const tools: ToolTrace[] = [];
  const pendingCalls = new Map<string, { name: string; input: unknown; thread: ThreadId }>();
  const threads: { id: ThreadId; label?: string }[] = [];
  const seenThreads = new Set<string>();
  const usage: Usage = { input: 0, output: 0 };
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let hasReasoning = false;
  let hasCacheRead = false;
  let hasCacheWrite = false;

  for (const envelope of committed) {
    if (envelope.threadId !== undefined && !seenThreads.has(envelope.threadId)) {
      seenThreads.add(envelope.threadId);
      threads.push({ id: envelope.threadId });
    }

    if (envelope.type === "toolCall" && envelope.threadId !== undefined) {
      const event = envelope.event as Event["toolCall"];
      pendingCalls.set(event.correlationId, {
        name: event.name,
        input: event.input,
        thread: envelope.threadId,
      });
    } else if (envelope.type === "toolResult") {
      const event = envelope.event as Event["toolResult"];
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
    } else if (envelope.type === "message") {
      const event = envelope.event as Event["message"];
      const message = event.message;
      if (message.role === "assistant") {
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
    }
  }

  if (hasReasoning) usage.reasoning = reasoning;
  if (hasCacheRead) usage.cacheRead = cacheRead;
  if (hasCacheWrite) usage.cacheWrite = cacheWrite;

  return {
    output,
    world,
    tools,
    traversal: [],
    visits: [],
    usage,
    latency,
    threads,
    lastReply: () => undefined,
    messages: () => [],
  };
}

/** Advances `flow` exactly one node, folding the result into a Run. `world` (if given) travels onto Run.world unchanged — this module never reads or mutates it, only the caller's own fixtures do. @public */
export async function stepOnce<World, Output = unknown>(
  flow: Graph,
  runtime: Runtime,
  world?: World,
): Promise<Run<World, Output>> {
  void flow;
  void runtime;
  void world;
  await Promise.resolve();
  return notImplemented("stepOnce");
}

/** Drives `flow` until every lane is parked or done, folding the result into a Run. `world` (if given) travels onto Run.world unchanged. @public */
export async function stepUntilBlocked<World, Output = unknown>(
  flow: Graph,
  runtime: Runtime,
  world?: World,
): Promise<Run<World, Output>> {
  const started = Date.now();
  await lowLevelStepUntilBlocked(flow, runtime);
  const latency = Date.now() - started;
  return foldRun<World, Output>(runtime.store.events(), world as World, latency);
}

/** Drives `flow` until `condition` holds, folding the result into a Run. `world` (if given) travels onto Run.world unchanged. @public */
export async function stepUntil<World, Output = unknown>(
  flow: Graph,
  runtime: Runtime,
  condition: (state: StepResult) => boolean,
  world?: World,
): Promise<Run<World, Output>> {
  void flow;
  void runtime;
  void condition;
  void world;
  await Promise.resolve();
  return notImplemented("stepUntil");
}
