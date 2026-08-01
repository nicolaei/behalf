// Systems running flows — the extension seam. See docs/reference.md.

import type { ScopeId, ScopeAction } from "../graph/thread.js";
import type { Event, EventType } from "../session/event.js";
import type { CommittedEnvelope, Stream } from "../session/envelope.js";
import type { InboxMessage } from "../session/session-store.js";
import type { WaitableSource } from "./waitable-source.js";
import type { Runtime } from "./runtime.js";
import type { StepIdentity } from "./routing.js";
import { freshScopeId } from "./ids.js";

/**
 * The runtime's per-scope handle, passed to an extension's context factories
 * (`stepContext`/`edgeContext`) and to its `seedScope` hook.
 * @public
 */
export interface ExecutionScope {
  readonly scope: ScopeId;
  /** The runtime this scope belongs to — an extension needs it to reach the store and
   * whatever per-runtime state of its own it keyed off it (ai's model/tool resolvers). */
  readonly runtime: Runtime;
  /** This scope's slice of the committed log, in log order. */
  events(): readonly CommittedEnvelope[];
  /**
   * This extension's replayed state for the scope — folds `events()` through
   * `extension`'s own registered `reducers`, in log order, from scratch every
   * call (no caching: the log is the only thing that may survive between
   * calls). `undefined` when the named extension isn't registered, or declares
   * no `reducers` — an extension with none simply has no scope state.
   */
  state(extension: string): unknown;
  /** Commits a standalone event to this scope — the same append path every step uses. */
  appendEvent<T extends EventType>(payload: Event[T], type: T): void;
  /**
   * Derives the scope a subsequent operation on THIS SAME context should run on, per
   * `action`: `"same"` returns this scope's own id, unchanged; `"fork"`/`"new"` mint a
   * fresh id (core's own branch-identity generator — the same deterministic counter
   * `context.invalidate`'s structural decision uses) and switch this context's own
   * "current scope" so every following `appendEvent`/`state()`/`openStream` call on
   * it lands on the new one. This is what lets an extension's own `ctx.thread.start`/
   * `fork` (ai's stepContext/edgeContext contribution) actually redirect where
   * downstream execution and logging go, while staying purely event-sourced: replay
   * recognizes the same transition generically, from whichever scope the next
   * committed envelope is tagged with — no separate replay-side bookkeeping needed.
   */
  deriveScope(action: ScopeAction): ScopeId;
  /** The currently-running node's own declared label, if any — present only on a `StepContext`'s
   * own scope handle (an edge has no single "currently running node"). Backs ai's `ctx.thread.label`. */
  label?(): string | undefined;
}

/**
 * An `ExecutionScope` for a scope that has a currently-running NODE — what an
 * extension's `stepContext` hook gets, as opposed to `edgeContext`'s (an edge
 * has no single running node to attribute anything to).
 *
 * The two extra exposures are what let a capability build its own
 * node-attributed operations through the seam instead of the engine holding
 * them as built-in `StepContext` fields: `openStream` opens a logged stream
 * tagged with the running node (ai's model reply), and `identity` names the
 * running node so a call can be attributed to it (ai's tool call).
 * @public
 */
export interface StepExecutionScope extends ExecutionScope {
  /** Opens a fresh stream on this scope, attributed to the currently-running node. */
  openStream(type: EventType): Stream;
  /** The currently-running node's identity. Throws `purpose` as its message when no node is
   * running — `purpose` is the caller's own "X called outside a running node" wording. */
  identity(purpose: string): StepIdentity;
}

/**
 * The seam through which a capability (ai, timers, …) attaches to a `Runtime` without the
 * engine knowing its vocabulary.
 * @public
 */
export interface EngineExtension {
  /** Identifies the extension in diagnostics; not yet used to key anything. */
  readonly name: string;
  /**
   * Merged into every `StepContext` the runtime builds, alongside the built-in fields.
   * A contributed key that collides with another extension's, or with a built-in
   * `StepContext` field, is a real ambiguity — the runtime throws rather than silently
   * picking a last-writer-wins policy.
   */
  stepContext?(scope: StepExecutionScope): Record<string, unknown>;
  /**
   * Merged into every `EdgeContext` the runtime builds for an edge whose `run` function
   * fires — alongside the built-in `scope`/`appendEvent` fields. Same collision rule as
   * `stepContext`: a contributed key colliding with a built-in `EdgeContext` field, or with
   * another extension's contribution, throws rather than silently picking a winner.
   */
  edgeContext?(scope: ExecutionScope): Record<string, unknown>;
  /**
   * Replay folds: how this extension's own events rebuild its scope state, one event
   * type at a time. Called in log order, only for the event types this extension itself
   * declares a reducer for — never for another extension's, and never for core's own
   * six event types (input/output/signal/stateChange/invalidation/error), which `tick`
   * always handles inline. Backs `ExecutionScope.state(this.name)`.
   */
  reducers?: Partial<Record<EventType, ScopeStateReducer>>;
  /**
   * Called once, synchronously, whenever `context.invalidate(...)`'s own scope-lifecycle
   * decision resolves — whichever scope ends up current (unchanged for `"same"`, freshly
   * minted for `"fork"`/`"new"`) — passing along the generic `payload`, if any. This is
   * the extension-payload counterpart to `deriveScope`: core decides WHICH scope a rerun
   * lands on; an extension that cares what `payload` means (ai's own reason/message shape)
   * seeds that scope's own state here, via the given `appendEvent`. A no-op for an
   * extension that registers none.
   */
  seedScope?(
    scope: ScopeId,
    payload: unknown,
    appendEvent: <T extends EventType>(payload: Event[T], type: T) => void,
  ): void;
  /**
   * Called once a `waitFor`/`interrupt` node has consumed a pending inbox entry, so the
   * extension that OWNS that entry's vocabulary can commit it to the log under its own
   * event type. The engine has no event type for a consumed message: `InboxMessage` is a
   * bare `{ kind?: string }` as far as core is concerned, and how it becomes a durable
   * fact is the claiming extension's decision (ai commits it as its own `"message"`
   * event, which its `messageReducer` folds back onto the thread).
   *
   * This is the same shape as `seedScope`: core decides WHEN a fact is committed and on
   * which scope; the extension decides WHAT is committed. A no-op for an extension that
   * registers none — an engine with no extension claiming the entry consumes it and
   * commits nothing, since there is nothing it could honestly write.
   */
  commitInboxMessage?(
    message: InboxMessage,
    appendEvent: <T extends EventType>(payload: Event[T], type: T) => void,
  ): void;
  /**
   * `commitInboxMessage`'s read-side counterpart, and the reason it exists: replay has to
   * recognize, from the log alone, that a `waitFor` node was already satisfied by a
   * consumed inbox entry — and it must do so without knowing which event type the
   * claiming extension chose to commit it under.
   *
   * Given a committed envelope, an extension answers "yes, that is one of MINE, and here
   * is the message it carries" (the value replay then routes downstream, exactly as the
   * live `waitFor` routed it) or `undefined` for anything it does not own. The first
   * extension to claim an envelope wins; core's own six event types are never offered.
   *
   * Until B3.1 the engine simply hardcoded `envelope.type === "message"` in three replay
   * sites — a private agreement with ai's vocabulary living inside the engine, invisible
   * to any import scan. This hook is that agreement, made explicit and owned by the side
   * that actually chose the word.
   */
  inboxMessageOf?(envelope: CommittedEnvelope): InboxMessage | undefined;
  /** Park conditions this extension can satisfy — each is started the same way `runtime()`
   * already starts an extension's `workers`, with no separate setup required by any caller. */
  waitables?: WaitableSource[];
  /**
   * Background workers started once `runtime()` has built its `Runtime` — the ai extension
   * registers the decoupled tool executor here. Each returned function is invoked once,
   * immediately; `runtime()` never awaits its promise (a worker commonly loops forever until
   * `signal` aborts) but collects it so `Runtime.stop()` can await every worker's exit after
   * aborting `signal`. Any async setup a worker needs (e.g. resolving toolset bindings) belongs
   * inside the returned function's own body, before its first real work — nothing outside this
   * extension can rely on that setup having finished before the function is even called.
   */
  workers?(runtime: Runtime, signal: AbortSignal): (() => Promise<void>)[];
}

/**
 * A pure fold, called during replay in log order: given this extension's own state so far
 * (`undefined` until its first matching event) and the next committed event of a type it
 * declared a reducer for, returns the next state. Never touches cursor position — that stays
 * core/edge-function territory (see `EngineExtension.reducers`'s own doc comment); a reducer
 * only ever reconstructs a value, the same way every replay in this engine reconstructs
 * everything else purely from the log.
 * @public
 */
export type ScopeStateReducer = (
  state: unknown,
  event: CommittedEnvelope,
  scope: ScopeId,
) => unknown;

/**
 * Backs `ExecutionScope.state(extension)`: folds `events` through `extension`'s own
 * registered `reducers`, in log order, from scratch — no state survives between calls,
 * same discipline every other replay reconstruction in this engine follows. `undefined`
 * when `extension` isn't registered, or declares no `reducers` of its own; an event whose
 * type isn't in its `reducers` map is skipped, not folded.
 */
export function foldExtensionState(
  events: readonly CommittedEnvelope[],
  extension: EngineExtension | undefined,
  scope: ScopeId,
): unknown {
  if (!extension?.reducers) return undefined;
  let state: unknown;
  for (const event of events) {
    const reducer = extension.reducers[event.type];
    if (!reducer) continue;
    state = reducer(state, event, scope);
  }
  return state;
}

/** Notifies every registered extension's own `seedScope` hook, if it has one — the shared tail `context.invalidate`'s resolution (and `routeAbort`'s synthesized equivalent) both call once a scope-lifecycle decision has settled. A no-op when `payload` is `undefined` or no extension registers the hook. */
export function seedScope(
  extensions: readonly EngineExtension[],
  scope: ScopeId,
  payload: unknown,
  appendEvent: <T extends EventType>(payload: Event[T], type: T) => void,
): void {
  if (payload === undefined) return;
  for (const extension of extensions) {
    extension.seedScope?.(scope, payload, appendEvent);
  }
}

/** Offers a consumed inbox entry to every registered extension's own `commitInboxMessage` hook — the shared tail `driveWaitForMessage` calls once a `waitFor`/`interrupt` has taken a message off the inbox. A no-op when no extension registers the hook. */
export function commitInboxMessage(
  extensions: readonly EngineExtension[],
  message: InboxMessage,
  appendEvent: <T extends EventType>(payload: Event[T], type: T) => void,
): void {
  for (const extension of extensions) {
    extension.commitInboxMessage?.(message, appendEvent);
  }
}

/**
 * Asks each registered extension whether `envelope` is a committed inbox entry of its own
 * (see `EngineExtension.inboxMessageOf`), returning the first claim. `undefined` when no
 * extension owns it — which is the answer for every core event type and for an engine
 * running with no extensions at all, and tells replay this envelope never satisfied a
 * `waitFor`.
 */
export function inboxMessageOf(
  extensions: readonly EngineExtension[],
  envelope: CommittedEnvelope,
): InboxMessage | undefined {
  for (const extension of extensions) {
    const message = extension.inboxMessageOf?.(envelope);
    if (message !== undefined) return message;
  }
  return undefined;
}

/** Builds a `deriveScope` implementation for a mutable "current scope" cell — shared by `step-runner.ts`'s `makeExecutionScope` and `routing.ts`'s `makeEdgeExecutionScope`, the two places an `ExecutionScope` is actually constructed. */
export function makeDeriveScope(
  runtime: Runtime,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
): (action: ScopeAction) => ScopeId {
  return (action) => {
    if (action === "same") return getScope();
    const next = freshScopeId(runtime);
    setScope(next);
    return next;
  };
}
