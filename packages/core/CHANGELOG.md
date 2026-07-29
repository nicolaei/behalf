# @behalf-js/core

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
