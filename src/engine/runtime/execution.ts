// Tool and model execution: resolving a named tool's handler, building the
// ToolContext handlers run with, running one tool call end to end, and
// making one model request (with its own tool calls folded in).

import type {
  Message,
  MessageKind,
  UserMessage,
  AssistantMessage,
  ContentBlock,
} from "../../flow/message.js";
import type { Waitable } from "../../flow/waitable.js";
import type { NodeId } from "../../flow/graph.js";
import type { ThreadId } from "../../flow/thread.js";
import type { Profile } from "../../flow/profile.js";
import type { StepContext, ModelCallResult } from "../../flow/step.js";
import type { Tool, ToolContext, ToolHandler } from "../../flow/tool.js";
import type { SessionStore } from "../session-store.js";
import type { Runtime } from "../runtime.js";
import { runFlow } from "../runtime.js";
import { freshCorrelationId } from "./ids.js";
import { unreachable } from "../errors.js";
import { withMessage, type Thread, type StepIdentity } from "./routing.js";

/**
 * Parks until `poll` returns a value, waking on `store.awaitReceive()` so a
 * `store.receive()` racing this call — before or after it starts — is never
 * missed, without spinning a timer while nothing's ready. Stops early once
 * `stop` says so, if given.
 */
async function pollInbox<T>(
  store: SessionStore,
  poll: () => T | undefined,
  stop?: () => boolean,
): Promise<T | undefined> {
  while (!stop?.()) {
    const value = poll();
    if (value) return value;
    await store.awaitReceive();
  }
  return undefined;
}

/** Consumes one pending `signal` entry, if any is queued, and commits it to the log as a `signal` event — the "drain one pending signal and commit it" step every non-message `waitFor` path repeats (blocking here in `waitForSignal`/`waitForRace`, or peeked non-blockingly in `tick`/`runBranchNode`) until its `Waitable`'s own `match()` catches up with the log. Returns whether an entry was drained. */
export function drainOnePendingSignal(store: SessionStore): boolean {
  const entry = store.consume((candidate) => candidate.kind === "signal");
  if (entry?.kind !== "signal") return false;
  store.append(
    { name: entry.name, ...(entry.payload !== undefined ? { payload: entry.payload } : {}) },
    { type: "signal" },
  );
  return true;
}

/** Parks until the inbox has a message of the given kind. */
export async function waitForMessage(
  store: SessionStore,
  kinds: readonly MessageKind[],
): Promise<UserMessage> {
  const entry = await pollInbox(store, () =>
    store.consume(
      (candidate) =>
        candidate.kind === "message" &&
        candidate.message.kind !== undefined &&
        kinds.includes(candidate.message.kind),
    ),
  );
  // pollInbox only returns undefined when given a `stop` predicate, which this call omits.
  if (entry?.kind !== "message") unreachable("waitForMessage resolved without a message");
  return entry.message;
}

/** Non-blocking counterpart to `waitForMessage`: checks whether a message of one of the given kinds is already sitting in the inbox, consuming and returning it if so — `undefined` otherwise, never parking. Shared by tick's own waitFor handling and `runBranchNode`'s `"peek"` mode, both of which must never block. */
export function peekMessageFromInbox(
  store: SessionStore,
  kinds: readonly MessageKind[],
): UserMessage | undefined {
  const entry = store.consume(
    (candidate) =>
      candidate.kind === "message" &&
      candidate.message.kind !== undefined &&
      kinds.includes(candidate.message.kind),
  );
  return entry?.kind === "message" ? entry.message : undefined;
}

/**
 * Parks until a non-`userInput` `Waitable` (a signal-based one, today's only
 * other provider) is satisfied: drains one pending `signal` entry at a time,
 * committing each as a `signal` event — a durable fact, never folded into
 * `thread.messages` — then re-checks the `Waitable`'s own `match()` against
 * the committed log. A signal that doesn't satisfy this waitFor still gets
 * committed (so a later, different waitFor or a replay can see it) and
 * polling continues. Mirrors `waitForMessage`'s polling shape, but the match
 * itself is delegated to the `Waitable` rather than a kind check against the
 * live inbox, since a signal's identity lives in its committed event, not in
 * anything message-shaped.
 */
export async function waitForSignal<T>(store: SessionStore, waitable: Waitable<T>): Promise<T> {
  const result = await pollInbox(store, () => {
    for (;;) {
      const matched = waitable.match(store.events());
      if (matched !== undefined) return { value: matched };

      if (!drainOnePendingSignal(store)) return undefined;
      // Loop back around: the freshly committed signal may or may not be
      // what `waitable` is looking for — either way, re-check `match()`
      // before trying to drain another pending entry.
    }
  });
  return result?.value as T;
}

/** One armed `interrupt` node together with its message kind, if it has one — precomputed once per race so `waitForRace` never calls `tryMessageKindOf` per poll tick. */
interface ArmedInterrupt {
  id: NodeId;
  waitable: Waitable<unknown>;
  messageKind: MessageKind | undefined;
}

/** Which armed Waitable a race settled on: the waitFor node's own ("self"), or a specific `interrupt` node — never both, since `waitForRace` stops polling the instant either is satisfied. */
export type RaceWinner =
  | { kind: "self"; message: UserMessage }
  | { kind: "interrupt"; interrupt: { id: NodeId; waitable: Waitable<unknown> }; value: unknown };

/** Step (a) of `waitForRace`'s poll: consumes a pending message matching the waitFor node's own kind or any message-based interrupt's kind, and classifies which one it belongs to — the interrupt whose kind matches, or "self" (the waitFor node's own Waitable) when none does. `undefined` when no matching message is queued yet. */
function consumeRaceMessage(
  store: SessionStore,
  messageKinds: readonly MessageKind[],
  interrupts: readonly ArmedInterrupt[],
): RaceWinner | undefined {
  const message = store.consume(
    (candidate) =>
      candidate.kind === "message" &&
      candidate.message.kind !== undefined &&
      messageKinds.includes(candidate.message.kind),
  );
  if (message?.kind !== "message") return undefined;
  const interrupt = interrupts.find((candidate) => candidate.messageKind === message.message.kind);
  return interrupt
    ? { kind: "interrupt", interrupt, value: message.message }
    : { kind: "self", message: message.message };
}

/** Step (b) of `waitForRace`'s poll: checks every signal-based interrupt's own `match()` against the committed log, returning the first one satisfied. `undefined` when none is. */
function checkSignalInterrupts(
  signalInterrupts: readonly ArmedInterrupt[],
  store: SessionStore,
): RaceWinner | undefined {
  for (const interrupt of signalInterrupts) {
    const matched = interrupt.waitable.match(store.events());
    if (matched !== undefined) return { kind: "interrupt", interrupt, value: matched };
  }
  return undefined;
}

/**
 * Races a `waitFor` node's own message-based `Waitable` against every armed
 * `interrupt` — message-based or signal-based alike — resolving with
 * whichever is satisfied first. Each poll tick:
 *  1. checks the pending inbox for a message matching the node's own kind
 *     or any message-based interrupt's kind (same shape as `waitForMessage`);
 *  2. checks every signal-based interrupt's own `match()` against the
 *     committed log;
 *  3. if neither is ready, drains one pending signal, commits it (so a
 *     match on step 2 sees it next tick, or a different Waitable's later
 *     race can), and loops.
 * A signal-based interrupt's `match()` — not a kind string — decides
 * whether it fired, since a signal has no message kind to compare; a
 * message-based interrupt is still resolved by kind, same as today,
 * because `waitForMessage`'s inbox check needs a kind to look for before
 * any message has arrived to call `match()` on. Only interrupt nodes ever
 * feed the signal branch — the waitFor node's own Waitable is always
 * message-based here, `driveWaitForNode` having already routed a
 * non-message Waitable through `waitForSignal` directly with no race.
 */
export async function waitForRace(
  store: SessionStore,
  waitKind: MessageKind,
  interrupts: readonly ArmedInterrupt[],
): Promise<RaceWinner> {
  const messageKinds = [
    waitKind,
    ...interrupts
      .map((interrupt) => interrupt.messageKind)
      .filter((kind): kind is MessageKind => kind !== undefined),
  ];
  const signalInterrupts = interrupts.filter((interrupt) => interrupt.messageKind === undefined);

  const result = await pollInbox(store, () => {
    for (;;) {
      const messageWinner = consumeRaceMessage(store, messageKinds, interrupts);
      if (messageWinner) return { value: messageWinner };

      const signalWinner = checkSignalInterrupts(signalInterrupts, store);
      if (signalWinner) return { value: signalWinner };

      if (!drainOnePendingSignal(store)) return undefined;
      // Loop back around: re-check every signal-based interrupt's match()
      // against the freshly committed signal before draining another one.
    }
  });
  // pollInbox only returns undefined when given a `stop` predicate, which this call omits.
  if (!result) unreachable("waitForRace resolved without a winner");
  return result.value;
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
  const entry = await pollInbox(
    store,
    () =>
      store.consume(
        (candidate) => candidate.kind === "message" && candidate.message.intent === "abort",
      ),
    isCancelled,
  );
  return entry?.kind === "message" ? entry.message : undefined;
}

function isToolCall(block: ContentBlock): block is Extract<ContentBlock, { type: "toolCall" }> {
  return block.type === "toolCall";
}

/** Resolves every `kind === "toolset"` binding's members (via its `discover()`, called exactly once) merged with every `kind === "tool"` binding — a single name-keyed lookup `findToolBinding` reads from. Keyed off the returned `Runtime` in a module-scoped `WeakMap` rather than the public type, so this stays an implementation detail (see docs/reference.md's `Runtime` interface). Exported so `runtime()`'s own factory can populate it. */
export const resolvedTools = new WeakMap<Runtime, Map<string, ToolHandler>>();

/** Finds the resolved handler for a named tool — direct or a toolset member — or throws if the runtime has none. */
export function findToolBinding(runtime: Runtime, name: string): ToolHandler {
  const handler = resolvedTools.get(runtime)?.get(name);
  if (!handler) throw new Error(`no tool binding for "${name}"`);
  return handler;
}

/** The `ToolContext` every tool handler runs with, wherever it's called from. */
export function buildToolContext(
  threadId: ThreadId,
  runtime: Runtime,
  identity: StepIdentity,
): ToolContext {
  return {
    thread: threadId,
    openStream: (type) =>
      runtime.store.open({
        correlationId: freshCorrelationId(runtime),
        type,
        threadId,
        ...identity,
      }),
    runFlow: (flow, initialPrompt) =>
      runFlow(flow, initialPrompt, runtime, { parentThreadId: threadId }),
  };
}

/**
 * Runs one tool call: invokes its bound handler, logs the result,
 * and folds the result into the thread as a tool message so the next model
 * call sees it. Assumes its caller has already committed the `toolCall`
 * event — `runModelCall` owns that half of the request.
 */
export async function runToolCall(
  call: Extract<ContentBlock, { type: "toolCall" }>,
  context: StepContext,
  runtime: Runtime,
  identity: StepIdentity,
  setThread: (thread: Thread) => void,
): Promise<void> {
  const handler = findToolBinding(runtime, call.name);

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
  setThread(withMessage(context.thread, toolMessage));
}

/**
 * Calls a tool directly, with no model in the loop: resolves its binding and
 * returns the handler's result as-is — no logging or thread-folding, unlike
 * `runToolCall`, since nothing here asks a model to see the result.
 */
export async function callTool<Input, Output>(
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
export async function runModelCall(
  profile: Profile,
  context: StepContext,
  runtime: Runtime,
  identity: StepIdentity,
  setThread: (thread: Thread) => void,
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
  setThread(withMessage(context.thread, reply));

  const toolCalls = reply.content.filter(isToolCall);
  for (const call of toolCalls) {
    runtime.store.append(
      { correlationId: call.correlationId, name: call.name, input: call.input },
      { type: "toolCall", threadId: context.thread.id },
    );
  }
  for (const call of toolCalls) {
    await runToolCall(call, context, runtime, identity, setThread);
  }

  return {
    usedTools: toolCalls.length > 0,
    usage: reply.usage,
    toolCalls: toolCalls.map((call) => ({ correlationId: call.correlationId, name: call.name })),
  };
}
