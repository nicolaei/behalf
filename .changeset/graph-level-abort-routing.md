---
"@behalf-js/core": patch
---

Made `flow.onAbort(target)` a real interrupt: aborting an in-flight turn now routes the graph to its
declared abort target instead of killing the whole run.
Previously a `ModelCallAbortedError` (raised when a user message with `intent: "abort"` preempts an
in-flight `context.modelCall`) fell through `runStep`'s generic `{ error }` path into
`handleStepError`, which — since the error is not retryable — decided `"fail"` and rejected the
entire long-lived driver loop, not just the current turn.

`tick()` (the driver `driveFlow` uses in production) now detects a step that failed because of an
abort and routes it to the nearest declared `onAbort` target, walking the live position's frame
stack from the innermost frame outward: a `use()`-embedded subgraph that declares no `onAbort` of
its own (e.g. `agentTurn`) bubbles to its enclosing graph's declaration.
The routing synthesizes the exact `{ invalidate: target, threadAction: "same" }` outcome a step's
own `context.invalidate(...)` would have produced and commits it through the existing
`commitInvalidation`, so an abort and an explicit invalidate reach one shared path. `"same"` because
the aborted attempt was never folded into the thread.
A graph with nobody in the chain declaring `onAbort` keeps today's behavior exactly — the run still
fails — so this is opt-in only.

`replayPosition`'s invalidation replay was generalized to match: because a graph-level abort targets
a node in an enclosing frame rather than the invalidating step's own graph, `applyInvalidationEvent`
now finds the frame whose graph actually owns the target (innermost-first, node ids being globally
unique) and truncates the position tree to that depth — identical to the old leaf-only reuse for an
ordinary `context.invalidate`. `agentTurn` and the `driveGraph`/`runFlow` path are untouched:
`agentTurn` stays abort-agnostic, and a one-shot `runFlow` still fails on abort.
