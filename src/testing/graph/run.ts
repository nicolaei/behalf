// Graph-test primitives — stepOnce/stepUntilBlocked/stepUntil folding a Run.
// Built directly on the existing low-level src/testing/index.ts primitives
// (same names, same StepResult-driving machinery over `tick()`) — this module
// just folds their result into a Run instead of a StepResult. No `input`
// parameter anywhere here: fake models/tools never read message content, so
// the empty thread `tick` already starts with is correct as-is.

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
import {
  stepUntilBlocked as lowLevelStepUntilBlocked,
  stepOnce as lowLevelStepOnce,
} from "../index.js";
import type { StepResult } from "../index.js";
import { StepUntilError } from "../errors.js";

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

/** One node's visit — its input, its output, and which thread it ran on. `input` is an approximation: [the previous committed output on this thread] (empty for a thread's first visit), not the engine's real resolved routing input — exact for linear/looped single-predecessor graphs, approximate for fan-out/fan-in nodes with multiple upstream branches (the log alone, without the Graph, can't recover the real value). @public */
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

// --- foldRun's concerns, each a stand-alone pass over the committed log ---

/** An `output` envelope, narrowed to the fields foldRun reads. */
type OutputEnvelope = CommittedEnvelope & { type: "output"; event: { value: unknown } };

/** An `OutputEnvelope` that also names the step and thread that produced it — what `traversal`/`visits` fold from. Envelopes from outside a `flow.step` (there are none today, but the type doesn't assume it) are excluded. */
type StepEnvelope = OutputEnvelope & { stepId: string; threadId: ThreadId };

function outputEnvelopesOf(committed: CommittedEnvelope[]): OutputEnvelope[] {
  return committed.filter((envelope): envelope is OutputEnvelope => envelope.type === "output");
}

function stepEntriesOf(outputEvents: OutputEnvelope[]): StepEnvelope[] {
  return outputEvents.filter(
    (envelope): envelope is StepEnvelope =>
      envelope.stepId !== undefined && envelope.threadId !== undefined,
  );
}

/** Every thread a run touched, in first-seen order. */
function collectThreads(committed: CommittedEnvelope[]): { id: ThreadId; label?: string }[] {
  const threads: { id: ThreadId; label?: string }[] = [];
  const seen = new Set<string>();
  for (const envelope of committed) {
    if (envelope.threadId !== undefined && !seen.has(envelope.threadId)) {
      seen.add(envelope.threadId);
      threads.push({ id: envelope.threadId });
    }
  }
  return threads;
}

/** Pairs each toolCall with its toolResult by correlationId. */
function pairTools(committed: CommittedEnvelope[]): ToolTrace[] {
  const tools: ToolTrace[] = [];
  const pendingCalls = new Map<string, { name: string; input: unknown; thread: ThreadId }>();

  for (const envelope of committed) {
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
    }
  }
  return tools;
}

/** What one pass over the committed "message" envelopes produces: the message lists `messages()` reads, the last-assistant-reply lookups `lastReply()` reads, and the token usage summed from every assistant message. One pass because all three read the same envelopes. */
interface MessageFold {
  allMessages: Message[];
  messagesByThread: Map<string, Message[]>;
  lastAssistantOverall: AssistantMessage | undefined;
  lastAssistantByThread: Map<string, AssistantMessage>;
  usage: Usage;
}

function foldMessages(committed: CommittedEnvelope[]): MessageFold {
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
    if (envelope.type !== "message") continue;
    const event = envelope.event as Event["message"];
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

  return { allMessages, messagesByThread, lastAssistantOverall, lastAssistantByThread, usage };
}

/** The nodes a run entered, in log order — one entry per committed step output. */
function foldTraversal(stepEntries: StepEnvelope[]): Traversal {
  return stepEntries.map((envelope) => ({
    node: envelope.stepId as NodeId,
    thread: envelope.threadId,
    ...(envelope.stepName ? { name: envelope.stepName } : {}),
  }));
}

/** Per-node visits, approximating each visit's input from the same thread's previous committed output (see `NodeVisit.input`'s doc comment). */
function foldVisits(stepEntries: StepEnvelope[]): NodeVisit[] {
  const lastOutputByThread = new Map<string, unknown>();
  return stepEntries.map((envelope) => {
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
  const outputEvents = outputEnvelopesOf(committed);
  const output = outputEvents.at(-1)?.event.value as Output;
  const stepEntries = stepEntriesOf(outputEvents);

  const threads = collectThreads(committed);
  const tools = pairTools(committed);
  const { allMessages, messagesByThread, lastAssistantOverall, lastAssistantByThread, usage } =
    foldMessages(committed);

  return {
    output,
    world,
    tools,
    traversal: foldTraversal(stepEntries),
    visits: foldVisits(stepEntries),
    usage,
    latency,
    threads,
    lastReply: (thread) =>
      thread === undefined ? lastAssistantOverall : lastAssistantByThread.get(thread),
    messages: (thread) =>
      thread === undefined ? allMessages : (messagesByThread.get(thread) ?? []),
  };
}

/** Advances `flow` exactly one node, folding the result into a Run. `world` (if given) travels onto Run.world unchanged — this module never reads or mutates it, only the caller's own fixtures do. @public */
export async function stepOnce<World, Output = unknown>(
  flow: Graph,
  runtime: Runtime,
  world?: World,
): Promise<Run<World, Output>> {
  const started = Date.now();
  await lowLevelStepOnce(flow, runtime);
  const latency = Date.now() - started;
  return foldRun<World, Output>(runtime.store.events(), world as World, latency);
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

/**
 * Drives `flow` until `condition` holds, folding the result into a Run.
 * `world` (if given) travels onto Run.world unchanged.
 *
 * Steps one node at a time (via the low-level `stepOnce`, mirroring how the
 * low-level `stepUntil` is itself built) rather than delegating straight to
 * the low-level `stepUntil`. The low-level driving loop only ever checks
 * `condition` against a *look-ahead* cursor — the position the next call
 * would run, not the node that just committed — so `atNode(step)` can never
 * be satisfied by a node that leads straight into another real step (its own
 * entry, in particular: entering it always executes it in the same tick()
 * call that reports the *following* node as "active"). This wrapper instead
 * checks `condition` against a synthesized state for the node(s) that just
 * committed this step, alongside the low-level look-ahead state (kept as a
 * fallback so ordinary mid-chain targeting still works) — same maxSteps
 * budget and stall/exhaustion errors as the low-level `stepUntil`, since nothing
 * about that contract changes, only which snapshot `condition` sees. Position
 * lives in `runtime.store`, so calling this again with a later condition
 * continues from where the previous call left off, same contract as `tick()`.
 * @public
 */
export async function stepUntil<World, Output = unknown>(
  flow: Graph,
  runtime: Runtime,
  condition: (state: StepResult) => boolean,
  world?: World,
): Promise<Run<World, Output>> {
  const started = Date.now();
  const maxSteps = 1000;

  for (let step = 0; step < maxSteps; step += 1) {
    const before = runtime.store.events().length;
    const state = await lowLevelStepOnce(flow, runtime);
    const justRan: StepResult = runtime.store
      .events()
      .slice(before)
      .filter(
        (envelope): envelope is CommittedEnvelope & { type: "output" } =>
          envelope.form === "committed" && envelope.type === "output",
      )
      .map((envelope) => ({
        laneId: `just-ran#${String(step)}`,
        node: envelope.stepId as NodeId,
        status: "active",
      }));

    if (condition(justRan) || condition(state)) break;

    if (state.every((lane) => lane.status !== "active")) {
      throw new StepUntilError(
        "stalled",
        `stepUntil: every lane is parked or done after ${String(step + 1)} step(s) ` +
          "without satisfying the condition",
      );
    }

    if (step === maxSteps - 1) {
      throw new StepUntilError(
        "budget-exceeded",
        `stepUntil: exceeded maxSteps (${String(maxSteps)}) without satisfying the condition`,
      );
    }
  }

  const latency = Date.now() - started;
  return foldRun<World, Output>(runtime.store.events(), world as World, latency);
}
