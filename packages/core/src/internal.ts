// Internal entry point — a straight re-export of `@behalf-js/engine/internal`,
// kept here so `@behalf-js/testing` (and anything else already importing
// `@behalf-js/core/internal`) sees the same unstable stepping surface after
// B3.1's package split. See that module for what these are and why they stay
// out of the main barrel.

export type { CursorState, TickOutcome } from "@behalf-js/engine/internal";
export { tick, tickUntilSuspended } from "@behalf-js/engine/internal";
