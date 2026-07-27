// The Learn "Handling errors" page's example: two ErrorHandlers exercised
// against real graphs in backoff.test.ts — one that fails a logical mistake
// fast, one that overrides the raiser's own `retryable` hint with its own
// retry policy.

import type { ErrorHandler } from "@behalf-js/core";

// #region handler
// A malformed reply is a mistake, not a flake: retrying it just spends the
// default handler's budget on the same bad output. Returning undefined for
// every other error type defers to the next handler in line — here, the
// built-in default that runtime() always appends after this one.
export const noRetryOnValidation: ErrorHandler = (error, context) => {
  if (error.type === "validation" && context.attempts === 0) return { action: "fail" };
  return undefined;
};
// #endregion handler

// #region backoff
// `error.retryable` is the raiser's own opinion, not a rule this handler has
// to follow: this flow knows its "flakyFetch" step is idempotent, so the
// handler retries it up to twice on its own schedule even when the raiser
// marks the error non-retryable.
export const retryFlakyFetchTwice: ErrorHandler = (error, context) => {
  if (error.type !== "flakyFetch") return undefined;
  if (context.attempts >= 2) return { action: "fail" };
  return { action: "retry" };
};
// #endregion backoff
