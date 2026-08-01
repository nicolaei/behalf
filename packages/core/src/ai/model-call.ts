// The ai extension's model half: making one model request end to end,
// including its abort race. Physically relocated out of runtime/execution.ts
// (B2.7) — see tool-executor.ts for the tool half.

import type { UserMessage, AssistantMessage, ContentBlock, Usage } from "./message.js";
import type { Profile } from "./profile.js";
import type { ThreadContext } from "./thread.js";
import type { SessionStore, StepExecutionScope } from "@behalf-js/engine";
import { StepAbortedError } from "@behalf-js/engine";
import { modelResolvers } from "./tool-executor.js";
import "./context.js"; // side-effect: registers the StepContext/EdgeContext ai declaration merge

/** Summary of a model call — whether tools were used and token usage. @public */
export interface ModelCallResult {
  usedTools: boolean;
  usage: Usage;
  toolCalls: { correlationId: string; name: string }[]; // requested this turn, in reply order
}

/**
 * Thrown by `context.modelCall` when a user message with `intent: "abort"`
 * preempts the in-flight call. What streamed so far is already committed to
 * the log, marked aborted (see `Stream.abort()`) — this is purely the signal
 * that the step itself didn't get a reply. Named so a flow author (e.g.
 * `agentTurn`'s own `respond` step) can catch it specifically and end the
 * turn gracefully, instead of it falling through runStep's generic
 * catch-all and failing the whole run as an ordinary, non-retryable error.
 *
 * Extends the engine's own `StepAbortedError`, which is how `tick` recognizes
 * an aborted step and routes it to the nearest declared `onAbort` target
 * without core ever naming a model call.
 * @public
 */
export class ModelCallAbortedError extends StepAbortedError {
  constructor() {
    super("model call aborted");
    this.name = "ModelCallAbortedError";
  }
}

/** Parks until an abort message reaches the inbox — stops the moment `isCancelled` says the
 * race that started it has already been decided some other way. */
async function waitForAbort(
  store: SessionStore,
  isCancelled: () => boolean,
): Promise<UserMessage | undefined> {
  for (;;) {
    if (isCancelled()) return undefined;
    const entry = store.consume(
      (candidate) =>
        candidate.kind === "message" && (candidate.message as UserMessage).intent === "abort",
    );
    if (entry?.kind === "message") return entry.message as UserMessage;
    await store.awaitReceive();
  }
}

function isToolCall(block: ContentBlock): block is Extract<ContentBlock, { type: "toolCall" }> {
  return block.type === "toolCall";
}

/**
 * Makes one model request and commits it to the log: the reply, and one `toolCall` event per
 * tool the reply asks for. Returns as soon as that's committed — it never runs or waits on a
 * tool call itself; the decoupled tool executor (`ai()`'s `workers` hook) resolves each
 * `toolCall` independently, whenever its handler settles. Does not call the model again itself:
 * a graph loops by routing a step's output back to itself, same as any other edge.
 *
 * Abort doesn't just race the model call and walk away from it — `controller.abort()` actually
 * tells the port's own transport to stop, so the real request stops instead of continuing to
 * stream after this function has already returned. `reply`'s own promise may still settle later
 * regardless; by the time that happens nobody is awaiting it anymore, so its eventual settlement
 * is silently caught purely to stop it surfacing as an unhandled rejection.
 */
export async function runModelCall(
  profile: Profile,
  scope: StepExecutionScope,
  thread: ThreadContext,
): Promise<ModelCallResult> {
  // Same guard the built-in `modelCall` field used to carry: a model call only
  // ever runs while a node is being processed, and `identity` throws with this
  // message when it isn't. The identity itself is unused — runModelCall no
  // longer runs a tool call inline, so it has nothing to attribute.
  scope.identity("modelCall called outside a running node");
  const runtime = scope.runtime;
  const resolveModel = modelResolvers.get(runtime);
  if (!resolveModel) {
    throw new Error(
      "no model resolver registered for this runtime — pass ai({ models, bindings }) via runtime({ extensions: [ai(...)] })",
    );
  }
  const port = resolveModel(profile.model);
  const stream = scope.openStream("message");
  const controller = new AbortController();

  let modelSettled = false;
  const replyPromise = port
    .respond(profile, thread.messages, stream, controller.signal)
    .then((message): { kind: "reply"; message: AssistantMessage } => {
      modelSettled = true;
      return { kind: "reply", message };
    });

  const outcome = await Promise.race([
    replyPromise,
    waitForAbort(runtime.store, () => modelSettled).then(
      (message): { kind: "abort" } | undefined => (message ? { kind: "abort" } : undefined),
    ),
  ]);

  if (!outcome || outcome.kind === "abort") {
    controller.abort();
    stream.abort();
    replyPromise.catch(() => undefined); // may still settle later; nobody's listening — silence it
    throw new ModelCallAbortedError();
  }

  const { message: reply } = outcome;
  // One commit only: the stream's own commit IS the logged `message` event the
  // messageReducer folds back into `ctx.thread.messages` — calling
  // `context.thread.say(reply)` here too would log the reply twice.
  stream.commit({ message: reply });

  const toolCalls = reply.content.filter(isToolCall);
  for (const call of toolCalls) {
    scope.appendEvent(
      { correlationId: call.correlationId, name: call.name, input: call.input },
      "toolCall",
    );
  }

  return {
    usedTools: toolCalls.length > 0,
    usage: reply.usage,
    toolCalls: toolCalls.map((call) => ({ correlationId: call.correlationId, name: call.name })),
  };
}
