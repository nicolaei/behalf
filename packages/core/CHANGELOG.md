# @behalf-js/core

## 0.0.7

### Patch Changes

- c4dda16: Abort now cancels the real model call, not just the flow — provider-agnostic.

  Previously an aborted turn only ever raced the model call and walked away from it: the underlying
  network request kept running in the background, so a still-streaming real call kept calling
  `stream.delta()` after the flow had already moved on.
  Visually, an aborted reply kept growing after the abort "succeeded".
  Separately, an abort with no text streamed yet built an assistant message with an empty text
  content block, which a real provider's API rejects outright — breaking the very next prompt.

  `ModelPort.respond` gains an optional 4th parameter, `signal?: AbortSignal` — a standard Web API,
  not specific to any one provider.
  Every existing 3-arg port implementation keeps compiling and behaving exactly as before.
  `runModelCall` builds a real `AbortController` and threads its signal into `respond()`, calling
  `controller.abort()` (not just `stream.abort()`) when the abort branch wins the race, so a
  cooperative port's own transport actually stops.
  The losing reply promise may still settle later regardless — a real network call isn't guaranteed
  to die the instant `abort()` is called, and an uncooperative port can ignore the signal entirely —
  so its eventual settlement is silently caught purely to avoid an unhandled rejection; a genuine
  model-call failure, unrelated to any abort, still rejects and still propagates exactly as before.

  `createAnthropicPort` threads the signal into the SDK's own `RequestOptions`
  (`client.messages.stream(body, { signal })`). `createOpenAIPort`'s stub signature updated to
  match, for whenever it's implemented.

  `memoryStore`'s `Stream` gets a `settled` guard: `delta()`/`commit()` become no-ops once the
  stream already committed or aborted — defense in depth for the real-world gap between "abort()
  called" and "the network actually stops," and for any port that ignores the signal. `abort()`'s
  built message now uses an empty content array, not an empty text block, when nothing streamed
  before the abort.

## 0.0.6

### Patch Changes

- dc58b7e: Made `flow.onAbort(target)` a real interrupt: aborting an in-flight turn now routes the
  graph to its declared abort target instead of killing the whole run.
  Previously a `ModelCallAbortedError` (raised when a user message with `intent: "abort"` preempts
  an in-flight `context.modelCall`) fell through `runStep`'s generic `{ error }` path into
  `handleStepError`, which — since the error is not retryable — decided `"fail"` and rejected the
  entire long-lived driver loop, not just the current turn.

  `tick()` (the driver `driveFlow` uses in production) now detects a step that failed because of an
  abort and routes it to the nearest declared `onAbort` target, walking the live position's frame
  stack from the innermost frame outward: a `use()`-embedded subgraph that declares no `onAbort` of
  its own (e.g. `agentTurn`) bubbles to its enclosing graph's declaration.
  The routing synthesizes the exact `{ invalidate: target, threadAction: "same" }` outcome a step's
  own `context.invalidate(...)` would have produced and commits it through the existing
  `commitInvalidation`, so an abort and an explicit invalidate reach one shared path. `"same"`
  because the aborted attempt was never folded into the thread.
  A graph with nobody in the chain declaring `onAbort` keeps today's behavior exactly — the run
  still fails — so this is opt-in only.

  `replayPosition`'s invalidation replay was generalized to match: because a graph-level abort
  targets a node in an enclosing frame rather than the invalidating step's own graph,
  `applyInvalidationEvent` now finds the frame whose graph actually owns the target
  (innermost-first, node ids being globally unique) and truncates the position tree to that depth —
  identical to the old leaf-only reuse for an ordinary `context.invalidate`. `agentTurn` and the
  `driveGraph`/`runFlow` path are untouched: `agentTurn` stays abort-agnostic, and a one-shot
  `runFlow` still fails on abort.

## 0.0.5

### Patch Changes

- 69dfe48: Fixed `tick()`'s forEach handling reusing a stale branch thread id when the same forEach
  node is re-entered on a later pass through a loop (the shape `agentTurn` uses for every turn that
  calls tools). `forEachBranchThreadId` derived a branch's thread id from only the forEach node's
  own stable id and the item's index — both constant across every replay, but NOT across a later
  invocation of the same static node on the same thread.
  A second pass through the loop's branch 0 got the identical thread id the first pass's branch 0
  already used, so `replayForEachBranch` walked into the first pass's already-completed, committed
  output instead of running the second pass's own tool wait — leaving the second pass's own
  `tool_use` blocks with no matching `tool_result` in the assembled message history (Anthropic's
  "unexpected tool_use_id" 400, reproduced live via `behalf-runner`).

  `buildForEachGroup` now folds in how many times this forEach node has already fully completed on
  this thread — reconstructed purely from the committed log (one "output" event per completed pass,
  tagged with the node's own stepId and thread), the same log-only reconstruction discipline
  `replayStateTracker` already uses — so every pass through a re-entered forEach node gets its own,
  non-colliding set of branch thread ids.

## 0.0.4

### Patch Changes

- 0c2cb7c: `agentTurn`'s conditional compaction policy is now overridable via a new
  `AgentTurnOptions.compact` (`AgentTurnCompactOptions`): `tokenBudget`, `keepLast`, and `summarize`
  were previously hardcoded module-level constants with no way for a caller to override any of them.
  `summarize` in particular was only ever meant to be a temporary stand-in default — a naive
  placeholder that states how many messages were folded away, not a real digest — the intent is for
  implementors to supply their own real summarizer (which can now be async, since a real one will
  likely call a model).
  All three fall back to their existing defaults when omitted, so existing callers see no behavior
  change.
- 84e6e6e: `executeToolCall` now always commits a `toolResult` event, even when the bound handler's
  promise rejects (folded in as `{ output: { error }, isError: true }`).
  Previously a rejecting handler's failure vanished with nowhere to surface: the only thing that
  resolves a pending `waitFor(toolCall(id))` is a matching `toolResult` event, so a handler that
  threw without producing one could stall an entire turn — and the whole session behind it —
  forever.
  A missing tool binding (no handler registered for that name in this runtime) is still left
  uncaught on purpose; that models a call meant to be resolved by another process sharing the same
  log, not a handler failure.

## 0.0.3

### Patch Changes

- 8349bac: Redesign compaction as a data effect instead of a routing `Emit`. `Emit` no longer
  carries a `compact` variant — it's routing-only now.
  Compaction runs as an awaited effect through `StepContext.compact()`, which has a new signature,
  and the on-disk "compaction" event format changed to match.
  Replay now correctly folds compaction, invalidation, and bare message events back into the thread
  instead of dropping them. `agentTurn`'s fold no longer force-compacts on every turn —
  `maybeCompact` decides whether to compact conditionally instead, based on the thread's actual
  size.

  This is a breaking change to the `Emit` and `StepContext.compact` shapes and to the persisted
  event format.
  It ships as a patch release: the package is still pre-1.0 and alpha, and nothing external depends
  on specific versions yet.

## 0.0.2

### Patch Changes

- e97ed59: Add `driveFlow` — a wrapper around `tickUntilSuspended` that genuinely waits (via
  `runtime.store.awaitReceive()`) whenever every cursor is parked, instead of returning immediately.
  This is what lets a long-lived session actually notice an asynchronous tool call once it resolves
  — `tickUntilSuspended` alone stops the instant a `waitFor(toolCall(id))` peeks and finds nothing
  yet, and nothing calls it again on its own. `driveFlow` also needs no initial seed message, unlike
  `runFlow`: a fresh flow just parks at its own entry `waitFor` until a message arrives, and keeps
  resuming across as many turns as the caller needs in one call.

## 0.0.1

### Patch Changes

- Initial split of behalf into six scoped packages: `core` (flow authoring and the engine),
  `testing` (step-by-step test helpers and a fake model port), `models-anthropic`, `models-openai`
  (a stub whose `createOpenAIPort` throws "not implemented yet"), `tools` (the standard
  read/write/edit/bash bindings), and `stores` (an in-memory session store).
