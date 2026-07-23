# Handling errors

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

A step fails by emitting `{ error }` or by throwing. The runner, not the
graph, decides what happens next.

## You will learn

- The difference between a logical failure (route with `when`) and a broken
  step (an `error`, never routed by an edge)
- What `ErrorContext` gives a handler to decide with
- How to write a handler that returns `retry` or `fail`
- What the default backoff handler does when you supply none

## Logical failure vs. broken step

_A rejected review is an `output`; a thrown exception is an `error`. TODO._

## ErrorHandler

_`(error, context) => ErrorDecision | undefined`; first decision among
`errorHandlers` wins, `undefined` defers. Example ref:
`docs/examples/handling-errors/backoff.ts#handler`._

## Writing your own backoff

_`retryable` is advisory only — the handler owns policy. Example ref:
`#backoff`._

## The default handler

_Runs last; retries `retryable` errors with capped exponential backoff,
otherwise fails. TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Errors (full block, including the backoff example).
**Examples:** `docs/examples/handling-errors/backoff.ts` — regions: `handler`, `backoff`.
**Section:** [Agents in practice](./README.md)
**Prev / Next:** [Fan-out and joining](./fan-out-and-joining.md) / [Running flows](../wiring-a-runtime/running-flows.md)
