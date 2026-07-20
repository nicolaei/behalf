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
export async function waitForMessage(
  store: SessionStore,
  kinds: readonly MessageKind[],
): Promise<UserMessage> {
  const entry = await pollInbox(() =>
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
  const result = await pollInbox(() => {
    for (;;) {
      const matched = waitable.match(store.events());
      if (matched !== undefined) return { value: matched };

      const entry = store.consume((candidate) => candidate.kind === "signal");
      if (!entry) return undefined;
      if (entry.kind !== "signal") unreachable("waitForSignal: consumed a non-signal entry");
      store.append(
        { name: entry.name, ...(entry.payload !== undefined ? { payload: entry.payload } : {}) },
        { type: "signal" },
      );
      // Loop back around: the freshly committed signal may or may not be
      // what `waitable` is looking for — either way, re-check `match()`
      // before trying to drain another pending entry.
    }
  });
  return result?.value as T;
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
 * Runs one tool call: logs it, invokes its bound handler, logs the result,
 * and folds the result into the thread as a tool message so the next model
 * call sees it.
 */
export async function runToolCall(
  call: Extract<ContentBlock, { type: "toolCall" }>,
  context: StepContext,
  runtime: Runtime,
  identity: StepIdentity,
  setThread: (thread: Thread) => void,
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
    await runToolCall(call, context, runtime, identity, setThread);
  }

  return { usedTools: toolCalls.length > 0, usage: reply.usage };
}
