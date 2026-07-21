// A step's raw thrown error is always classified `retryable: false` by the
// engine's generic catch (see src/engine/runtime/step-runner.ts `runStep`) —
// only a `StepError` a step explicitly builds via `context.fail(...)` carries
// a real `retryable` hint. `chat.ts`'s `modelStep` uses `isRetryableProviderError`
// below to build that hint from the Anthropic SDK's thrown error.
//
// Separately, `behalf`'s built-in `defaultErrorHandler` retries with a base
// delay of 1ms — deliberately tiny so the library's own test suite stays
// fast, not meant for a real API's rate limits. `rateLimitBackoff` below is a
// realistic replacement: honors the API's `Retry-After` header when present,
// otherwise backs off in whole seconds, with a real retry cap.

import type { ErrorHandler } from "behalf";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2_000;

/** Anthropic's SDK throws `APIError` with a numeric `status`; 429 (rate limit)
 * and 5xx (transient server errors) are worth retrying, everything else isn't. */
export function isRetryableProviderError(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  return status === 429 || (status !== undefined && status >= 500);
}

function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { headers?: unknown } | undefined)?.headers;
  const raw =
    headers instanceof Headers
      ? headers.get("retry-after")
      : typeof headers === "object" && headers !== null
        ? (headers as Record<string, string>)["retry-after"]
        : undefined;
  const seconds = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

/** Real-world backoff for a rate-limited/transient provider error: honors
 * `Retry-After` when the API sends one, otherwise exponential in whole
 * seconds, capped at MAX_ATTEMPTS. Defers (returns undefined) for anything
 * else, letting `behalf`'s own defaultErrorHandler (always appended last)
 * make the final call. */
export const rateLimitBackoff: ErrorHandler = (error, context) => {
  if (!error.retryable || context.attempts >= MAX_ATTEMPTS) return undefined;
  const after = retryAfterMs(error.cause) ?? BASE_DELAY_MS * 2 ** context.attempts;
  return { action: "retry", after };
};
