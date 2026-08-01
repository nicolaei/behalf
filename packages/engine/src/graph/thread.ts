// Flow authoring — execution-branch identity. See docs/reference.md § "ScopeId".
//
// "Thread" (a conversation: message history, start/fork/say/end) is an ai word — the
// core concept underneath it is just an opaque execution-branch identity, needed for
// replay and fan-out bookkeeping regardless of whether any ai extension is registered.
// `ThreadAction`/`Thread` (message folding) moved to `ai/` in the thread-extraction step
// (B2 step 8); only the id and its three-state lifecycle action stay here.

/** Opaque brand for an execution branch's identity. Replaces today's `ThreadId` — "thread"
 * is an ai word; the core concept is just an opaque execution-branch identity. @public */
export type ScopeId = string & { readonly __brand: "ScopeId" };

/**
 * The three ways a rerun/routed target's execution branch can relate to the current one —
 * core's own minimal, ai-neutral branch-lifecycle primitive. A flow with no ai extension
 * registered still gets full fork/new capability through `context.invalidate`'s `action`:
 * - `same` (default) — continue this scope; no new id.
 * - `fork` — a new id, structurally linked back to the current one (`ExecutionScope`'s
 *   `deriveScope` mints it) — what content (if any) carries over onto it is an extension's
 *   own concern (ai's reducer, riding `payload`), not core's.
 * - `new` — a brand-new, unlinked id.
 * @public
 */
export type ScopeAction = "same" | "fork" | "new";
