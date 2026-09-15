// The ai extension's model half: making one model request end to end,
// including its abort race. Physically relocated out of runtime/execution.ts
// (B2.7) — see tool-executor.ts for the tool half.

import type { UserMessage, AssistantMessage, ContentBlock, Usage } from "./message.js";
import type { Profile } from "./profile.js";
import type { ThreadContext } from "./thread.js";
import type { SessionStore, StepExecutionScope, Runtime } from "@behalf-js/engine";
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

/**
 * Every in-flight model call's own preempt function, per Runtime — the model-half counterpart
 * to `liveToolCalls`. Calling one ends that call's race exactly as an abort message would,
 * without anything ever being placed in the inbox: with no pending entry there is no race
 * between the model half and the tool half over who consumes it, and no leftover entry to
 * detonate under the next turn.
 */
const liveModelCalls = new WeakMap<Runtime, Set<() => void>>();

/** Whether a model call is in flight for this runtime — half of ai's answer to `hasLiveWork`. */
export function hasLiveModelCall(runtime: Runtime): boolean {
  return (liveModelCalls.get(runtime)?.size ?? 0) > 0;
}

/** Preempts every in-flight model call for this runtime. Each throws `ModelCallAbortedError`,
 * commits what streamed marked aborted, and is routed to the nearest declared `onAbort`. */
export function preemptLiveModelCalls(runtime: Runtime): void {
  for (const preempt of liveModelCalls.get(runtime)?.values() ?? []) preempt();
}

function isToolCall(block: ContentBlock): block is Extract<ContentBlock, { type: "toolCall" }> {
  return block.type === "toolCall";
}

/**
 * Whether the round this model call would continue was itself cut short by a stop.
 *
 * This is the answer to a question the design never asked: a stop preempts the in-flight
 * model call, and `onAbort` is reached by the `ModelCallAbortedError` that preemption
 * throws — so when only a TOOL was live there was nothing to preempt, nothing routed to
 * `onAbort`, and the agent loop happily opened a fresh model call and wrote a whole reply
 * as if nothing had happened. The stop killed the command but not the turn.
 *
 * Rather than arm an in-memory "a stop happened" flag (the exact kind of state that can go
 * stale — see `runtime.abort()`), the refusal is derived from the log, which already carries
 * the fact: the toolResult the stop interrupted is committed with `aborted: true` on its
 * envelope. Scanning this scope's own slice backwards, the most recent `toolResult` decides;
 * a user message stops the scan first, because a fresh prompt is exactly what re-arms the
 * turn after it parked at `onAbort`.
 *
 * Being log-derived, it survives replay and needs no clearing: the same events read the same
 * way on a fresh process.
 */
function continuesAnAbortedRound(scope: StepExecutionScope): boolean {
  const events = scope.events();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const envelope = events[index];
    if (!envelope) continue;
    if (envelope.type === "toolResult") return envelope.aborted === true;
    if (envelope.type === "message") {
      const { message } = envelope.event as { message: { role: string } };
      if (message.role === "user") return false;
    }
  }
  return false;
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

  // A stop that landed while only a tool was live has no model call to preempt, so this is
  // where the turn actually ends: the call refuses to start, throws the same error a
  // preempted one throws, and is routed to the nearest declared `onAbort` by the machinery
  // that already existed. Nothing is written here — the mark is the aborted `toolResult`
  // already on the log.
  if (continuesAnAbortedRound(scope)) throw new ModelCallAbortedError();
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

  // Registered for the whole race, so `runtime.abort()` can end this call as a verb rather
  // than by leaving a message in the inbox. `waitForAbort` stays alongside it as internal
  // plumbing for the older inbox convention.
  let preempt!: () => void;
  const preempted = new Promise<{ kind: "abort" }>((resolve) => {
    preempt = () => {
      resolve({ kind: "abort" });
    };
  });
  let live = liveModelCalls.get(runtime);
  if (!live) {
    live = new Set();
    liveModelCalls.set(runtime, live);
  }
  live.add(preempt);

  let outcome: { kind: "reply"; message: AssistantMessage } | { kind: "abort" } | undefined;
  try {
    outcome = await Promise.race([
      replyPromise,
      preempted,
      waitForAbort(runtime.store, () => modelSettled).then(
        (message): { kind: "abort" } | undefined => (message ? { kind: "abort" } : undefined),
      ),
    ]);
  } finally {
    live.delete(preempt);
  }

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
