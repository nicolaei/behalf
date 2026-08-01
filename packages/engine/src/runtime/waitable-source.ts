// Systems running flows — WaitableSource. See docs/reference.md.

import type { SessionStore } from "../session/session-store.js";

/**
 * The impure side of a `Waitable` that declares no `inboxKind`: such a waitable
 * cannot be satisfied from the session's own pending inbox, so something has to
 * resolve it from outside. A `WaitableSource` is that something — it watches the
 * outside world and, when its condition happens, pushes a fact onto the session
 * log via `store.receive(...)`. Structurally independent of any one
 * `Runtime` or flow run — one `WaitableSource` instance can serve many
 * sessions over its own lifetime, the same way a Gateway does. `start` begins
 * watching a given store; the returned function stops it.
 * @public
 */
export interface WaitableSource {
  readonly provider: string;
  start(store: SessionStore): () => void;
}
