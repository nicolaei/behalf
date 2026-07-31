// The ai extension's model half: making one model request end to end,
// including its abort race. Physically relocated out of runtime/execution.ts
// (B2.7) — see tool-executor.ts for the tool half.

import type { UserMessage, AssistantMessage, ContentBlock } from "./message.js";
import type { Profile } from "./profile.js";
import type { StepContext, ModelCallResult } from "../graph/step.js";
import { ModelCallAbortedError } from "../graph/step.js";
import type { Runtime } from "../runtime/index.js";
import type { ScopeId } from "../graph/thread.js";
import type { SessionStore } from "../session/index.js";
import { modelResolvers } from "./tool-executor.js";
import "./context.js"; // side-effect: registers the StepContext/EdgeContext.thread declaration merge

/** Parks until an abort message reaches the inbox — stops the moment `isCancelled` says the
 * race that started it has already been decided some other way. */
async function waitForAbort(
  store: SessionStore,
  isCancelled: () => boolean,
): Promise<UserMessage | undefined> {
  for (;;) {
    if (isCancelled()) return undefined;
    const entry = store.consume(
      (candidate) => candidate.kind === "message" && candidate.message.intent === "abort",
    );
    if (entry?.kind === "message") return entry.message;
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
  context: StepContext,
  runtime: Runtime,
  setScope: (scope: ScopeId) => void,
): Promise<ModelCallResult> {
  void setScope; // reserved: a model call never itself transitions scope today
  const resolveModel = modelResolvers.get(runtime);
  if (!resolveModel) {
    throw new Error(
      "no model resolver registered for this runtime — pass ai({ models, bindings }) via runtime({ extensions: [ai(...)] })",
    );
  }
  const port = resolveModel(profile.model);
  const stream = context.openStream("message");
  const controller = new AbortController();

  let modelSettled = false;
  const replyPromise = port
    .respond(profile, context.thread.messages, stream, controller.signal)
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
    context.appendEvent(
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
