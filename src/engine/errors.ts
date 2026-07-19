// Systems running flows — Errors. See docs/reference.md § "Errors".

import type { ThreadId } from "../flow/thread.js";
import type { StepError } from "../flow/step.js";
import type { Envelope } from "../session/index.js";

export interface ErrorContext {
  step: { id: string; name?: string };
  thread: ThreadId;
  attempts: number; // times this step has already errored
  log: Envelope[]; // the session so far, to inspect
}

export type ErrorDecision = { action: "retry"; after?: number } | { action: "fail" };

/** Consulted in order after a step error; the first decision wins. `undefined` defers. */
export type ErrorHandler = (error: StepError, context: ErrorContext) => ErrorDecision | undefined;

/** A deliberately-unsupported feature gap — a stub awaiting real implementation in a later change. */
export function notImplemented(name: string): never {
  throw new Error(`${name} is not implemented yet`);
}

/** A structurally-impossible state — reaching this is a bug in the engine, not a missing feature. */
export function unreachable(name: string): never {
  throw new Error(`unreachable: ${name}`);
}
