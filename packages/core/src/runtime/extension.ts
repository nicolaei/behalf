// Systems running flows — the extension seam. See docs/reference.md.

import type { WaitableSource } from "./waitable-source.js";

/**
 * The seam through which a capability (ai, timers, …) attaches to a `Runtime` without the
 * engine knowing its vocabulary. This is step 1's skeleton: just enough for `runtime()` to
 * fold an extension's `waitables` into its existing `WaitableSource` handling. Later B2
 * steps extend this interface with `stepContext`/`edgeContext` factories, `workers`, and
 * `reducers` — additive members only, so today's extensions keep compiling unchanged.
 * @public
 */
export interface EngineExtension {
  /** Identifies the extension in diagnostics; not yet used to key anything. */
  readonly name: string;
  /** Park conditions this extension can satisfy — each is started the same way `runtime()`
   * already auto-starts the tool executor, with no separate setup required by any caller. */
  waitables?: WaitableSource[];
}
