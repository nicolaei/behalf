// Systems running flows — Errors. See docs/reference.md § "Errors".

import type { ThreadId } from "../flow/thread.js";
import type { StepError } from "../flow/step.js";
import type { Envelope } from "../session/index.js";

/** Context passed to an error handler: the step, thread, attempt count, and session log. @public */
export interface ErrorContext {
  step: { id: string; name?: string };
  thread: ThreadId;
  attempts: number; // times this step has already errored
  log: Envelope[]; // the session so far, to inspect
}

/** What an error handler returns: retry (optionally after a delay) or give up. @public */
export type ErrorDecision = { action: "retry"; after?: number } | { action: "fail" };

/** Consulted in order after a step error; the first decision wins. `undefined` defers. @public */
export type ErrorHandler = (error: StepError, context: ErrorContext) => ErrorDecision | undefined;

/** A deliberately-unsupported feature gap — a stub awaiting real implementation in a later change. */
export function notImplemented(name: string): never {
  throw new Error(`${name} is not implemented yet`);
}

/** A structurally-impossible state — reaching this is a bug in the engine, not a missing feature. */
export function unreachable(name: string): never {
  throw new Error(`unreachable: ${name}`);
}

/** Small cap on retries before giving up. */
const DEFAULT_RETRY_CAP = 3;

/** Base delay (ms) for exponential backoff between retries; kept tiny so tests stay fast. */
const DEFAULT_RETRY_BASE_DELAY_MS = 1;

/**
 * The built-in handler runtime() appends after any user-supplied handlers.
 * Retries retryable errors with exponential backoff up to a small cap, otherwise fails.
 * See docs/reference.md’s Errors section.
 */
export const defaultErrorHandler: ErrorHandler = (error, context) => {
  if (!error.retryable || context.attempts >= DEFAULT_RETRY_CAP) {
    return { action: "fail" };
  }
  const after = DEFAULT_RETRY_BASE_DELAY_MS * 2 ** context.attempts;
  return { action: "retry", after };
};
