// Systems running flows — the extension seam. See docs/reference.md.

import type { ThreadId } from "../graph/thread.js";
import type { Event, EventType } from "../session/event.js";
import type { CommittedEnvelope } from "../session/envelope.js";
import type { WaitableSource } from "./waitable-source.js";
import type { Runtime } from "./runtime.js";

/**
 * The runtime's per-scope handle, passed to an extension's context factories
 * (`stepContext` today; `edgeContext` and reducers in later B2 steps).
 *
 * `scope` is today's `ThreadId` — the design doc sketches this as `ScopeId`,
 * a rename that only lands with the thread-extraction step (B2 step 8); until
 * then this is the same identity `StepContext.thread.id` already carries.
 * @public
 */
export interface ExecutionScope {
  readonly scope: ThreadId;
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
  /** Commits a standalone event to this scope's thread — the same append path every step uses. */
  appendEvent<T extends EventType>(payload: Event[T], type: T): void;
}

/**
 * The seam through which a capability (ai, timers, …) attaches to a `Runtime` without the
 * engine knowing its vocabulary. B2.1 gave this just enough for `runtime()` to fold an
 * extension's `waitables` into its existing `WaitableSource` handling; B2.2 added
 * `stepContext`, merged into every `StepContext` the runtime builds; this step adds
 * `edgeContext`, merged into every `EdgeContext` the runtime builds when an edge with a
 * `run` function fires. Later B2 steps extend this interface further with `workers` and
 * `reducers` — additive members only, so today's extensions keep compiling unchanged.
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
  stepContext?(scope: ExecutionScope): Record<string, unknown>;
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
  scope: ThreadId,
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
  scope: ThreadId,
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
