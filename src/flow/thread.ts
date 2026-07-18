// Flow authoring — Threads. See docs/reference.md § "Threads".

export type ThreadId = string & { readonly __brand: "ThreadId" };

/**
 * - `same` (default) — continue this thread; context grows.
 * - `fork` — a new id sharing history up to the split point (`forkedFrom`).
 * - `new` — a brand-new empty thread with a fresh initial message.
 */
export type ThreadAction = "same" | "fork" | "new";
