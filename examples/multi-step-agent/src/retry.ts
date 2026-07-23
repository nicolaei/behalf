// behalf's own createAnthropicPort now classifies a real 429/5xx itself,
// throwing a RetryableError so runStep's generic catch sees the right
// `retryable` hint automatically — no per-graph try/catch needed (see
// isRetryableAnthropicError in behalf's own src/adapters/models/anthropic.ts).
//
// `behalf`'s built-in `defaultErrorHandler` retries with a base delay of 1ms
// — deliberately tiny so the library's own test suite stays fast, not meant
// for a real API's rate limits. `rateLimitBackoff` below is a realistic
// replacement: honors the API's `Retry-After` header when present,
// otherwise backs off in whole seconds, with a real retry cap.

import type { ErrorHandler } from "behalf";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2_000;

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
