---
"@behalf-js/core": minor
---

Add `driveFlow` — a wrapper around `tickUntilSuspended` that genuinely waits (via
`runtime.store.awaitReceive()`) whenever every cursor is parked, instead of returning
immediately. This is what lets a long-lived session actually notice an asynchronous
tool call once it resolves — `tickUntilSuspended` alone stops the instant a
`waitFor(toolCall(id))` peeks and finds nothing yet, and nothing calls it again on
its own. `driveFlow` also needs no initial seed message, unlike `runFlow`: a fresh
flow just parks at its own entry `waitFor` until a message arrives, and keeps
resuming across as many turns as the caller needs in one call.
