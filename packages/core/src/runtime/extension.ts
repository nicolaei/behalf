// Systems running flows — the extension seam. See docs/reference.md.

import type { ThreadId } from "../graph/thread.js";
import type { Event, EventType } from "../session/event.js";
import type { CommittedEnvelope } from "../session/envelope.js";
import type { WaitableSource } from "./waitable-source.js";

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
   * This extension's replayed state for the scope.
   * TODO(B2 step 6): wire to the real per-extension replay state once reducers land.
   * Always returns `undefined` until then — no per-extension scope-state slot exists yet.
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
  /** Park conditions this extension can satisfy — each is started the same way `runtime()`
   * already auto-starts the tool executor, with no separate setup required by any caller. */
  waitables?: WaitableSource[];
}
