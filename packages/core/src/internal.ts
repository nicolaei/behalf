// Internal entry point — engine primitives `@behalf-js/testing` wraps in its
// own vocabulary (`stepOnce`, `stepUntilBlocked`, `atNode`). Not part of the
// main package entry (`.`), and not a stability-guaranteed public surface:
// a test author should depend on `@behalf-js/testing` instead of importing
// this directly. See docs/reference.md § "tick()" for why these stay out of
// the main barrel.

export type { CursorState, TickOutcome } from "./engine/runtime.js";
export { tick, tickUntilSuspended } from "./engine/runtime.js";
