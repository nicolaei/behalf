# @behalf-js/core

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
