---
"@behalf-js/core": patch
---

`executeToolCall` now always commits a `toolResult` event, even when the
bound handler's promise rejects (folded in as `{ output: { error },
isError: true }`). Previously a rejecting handler's failure vanished with
nowhere to surface: the only thing that resolves a pending
`waitFor(toolCall(id))` is a matching `toolResult` event, so a handler
that threw without producing one could stall an entire turn — and the
whole session behind it — forever. A missing tool binding (no handler
registered for that name in this runtime) is still left uncaught on
purpose; that models a call meant to be resolved by another process
sharing the same log, not a handler failure.
