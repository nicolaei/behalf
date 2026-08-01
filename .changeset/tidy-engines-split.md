---
"@behalf-js/engine": minor
"@behalf-js/core": minor
"@behalf-js/testing": minor
"@behalf-js/stores": minor
---

Extract the durable-execution engine into `@behalf-js/engine`.

`graph/`, `session/`, `gateway/`, and `runtime/` now live in their own package, with the same `.` /
`./internal` split core had. `@behalf-js/core` keeps `ai/` and re-exports the engine's whole
surface, so existing imports are unchanged; a durable workflow with no AI in it can now depend on
`@behalf-js/engine` alone. `@behalf-js/stores` and `@behalf-js/testing`'s root subpath do exactly
that.

Replay no longer recognizes a satisfied `waitFor` by matching the literal event type `"message"`.
The extension that claims an inbox entry (`EngineExtension.commitInboxMessage`) now also claims it
back out of the log (`EngineExtension.inboxMessageOf`), so the engine never names any extension's
vocabulary.
