# Handling errors

A step fails by emitting `{ error }` or by throwing.
The runner, not the graph, decides what happens next.

## You will learn

- The difference between a logical failure (route with `when`) and a broken step (an `error`, never
  routed by an edge)
- What `ErrorContext` gives a handler to decide with
- How to write a handler that returns `retry` or `fail`
- Why `retryable` is only ever a hint, not a rule the handler must follow
- What the default backoff handler does when you supply none

## Logical failure vs. broken step

A rejected review, a test suite that came back red: these are opinions the flow itself should route
on, not failures of the flow. `classify` in
[Thinking in behalf](../get-started/thinking-in-behalf.md) does exactly this — it emits a normal
`output` with a `decision` field, and an ordinary `when` edge sends it down the escalate or
auto-resolve branch.

A step that's actually broken (the provider timed out, a reply didn't parse, an unexpected
exception) is different: it emits `{ error }`, or throws and the runner wraps that throw as
`{ type: "unexpected", retryable: false }`.
An `error` is never routed by an edge — no `when` clause ever sees it.
Instead, the runner appends an error event and hands the decision to the runtime's `errorHandlers`.

## ErrorHandler

An `ErrorHandler` is a plain function: the error plus an `ErrorContext`, in; a decision or
`undefined`, out.

```ts
type ErrorContext = {
  step: { id: string; name?: string };
  thread: ThreadId;
  attempts: number; // times this step has already errored
  log: Envelope[]; // the session so far, to inspect
};

type ErrorDecision = { action: "retry"; after?: number } | { action: "fail" };
```

`runtime()`'s `errorHandlers` list is consulted in order; the first one to return a decision wins.
Returning `undefined` defers to the next handler in line, not "do nothing" — there's always at least
one more handler after yours, since `runtime()` appends its own default last.

```ts source=docs/examples/handling-errors/backoff.ts#handler
// A malformed reply is a mistake, not a flake: retrying it just spends the
// default handler's budget on the same bad output. Returning undefined for
// every other error type defers to the next handler in line — here, the
// built-in default that runtime() always appends after this one.
export const noRetryOnValidation: ErrorHandler = (error, context) => {
  if (error.type === "validation" && context.attempts === 0) return { action: "fail" };
  return undefined;
};
```

The code comment says why: retrying a malformed reply just spends the default handler's budget
re-running the same bad output, so this handler fails it on the spot instead, deferring everything
else to whatever comes after it.

## Writing your own backoff

`error.retryable` is the raiser's own opinion about itself, say a `ModelPort` marking a 429 as worth
retrying, not a rule your handler has to obey.
The handler owns policy; the raiser's hint is advice it's free to override.

```ts source=docs/examples/handling-errors/backoff.ts#backoff
// `error.retryable` is the raiser's own opinion, not a rule this handler has
// to follow: this flow knows its "flakyFetch" step is idempotent, so the
// handler retries it up to twice on its own schedule even when the raiser
// marks the error non-retryable.
export const retryFlakyFetchTwice: ErrorHandler = (error, context) => {
  if (error.type !== "flakyFetch") return undefined;
  if (context.attempts >= 2) return { action: "fail" };
  return { action: "retry" };
};
```

This flow knows its own `flakyFetch` step is idempotent, so it retries up to twice on its own
schedule even when the raiser marks the error `retryable: false`. `backoff.test.ts` proves both
halves of that: one test raises the error twice and lets the step succeed on its third attempt,
recovering despite `retryable: false`; a second lets it fail every time and confirms the flow gives
up, and confirms `runFlow` rejects, once the two-retry budget is spent.

> [!WARNING] `retryable` only ever informs a handler that chooses to read it.
> A handler ignoring it entirely, like `noRetryOnValidation` above, is just as valid: the field is
> advisory, never enforced.

## The default handler

`runtime()` always appends one more handler after any you supply: it retries `retryable` errors with
exponential backoff up to a small cap, and fails everything else.

```ts
const defaultErrorHandler: ErrorHandler = (error, context) => {
  if (!error.retryable || context.attempts >= DEFAULT_RETRY_CAP) return { action: "fail" };
  return { action: "retry", after: DEFAULT_RETRY_BASE_DELAY_MS * 2 ** context.attempts };
};
```

Supplying no `errorHandlers` at all doesn't mean no error handling: it means every error goes
straight to this one.
Writing your own handler, like `retryFlakyFetchTwice` above, only matters when the default's
one-size policy is wrong for a step you know more about.

## Recap

- A logical failure is an `output` you route with `when`; a broken step is an `error`, never routed
  by an edge
- `ErrorContext` gives a handler the step, its thread, its attempt count, and the session log
- `errorHandlers` runs in order; the first decision wins, `undefined` defers to the next one
- `retryable` is the raiser's own opinion, advisory only — a handler can retry past it or fail
  before it, as this page's two handlers each do
- `runtime()` always appends a default handler last: retry `retryable` errors with backoff up to a
  small cap, otherwise fail
- Next: how a runtime actually wires `models`, `bindings`, and `errorHandlers` together, in
  [Running flows](../wiring-a-runtime/running-flows.md)

---

**Reference:** reference.md § Errors (full block, including the backoff example). **Examples:**
`docs/examples/handling-errors/backoff.ts` — regions: `handler`, `backoff`. **Section:**
[Agents in practice](./README.md) **Prev / Next:** [Fan-out and joining](./fan-out-and-joining.md) /
[Running flows](../wiring-a-runtime/running-flows.md)
