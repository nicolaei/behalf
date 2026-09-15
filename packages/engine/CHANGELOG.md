# @behalf-js/engine

## 0.1.0

### Minor Changes

- 7621720: Ship a reusable `SessionStore` conformance suite from `@behalf-js/testing`.

  `sessionStoreConformance(name, makeStore)` registers the whole `SessionStore` contract as a vitest
  `describe` block, so a host that writes its own store checks it against the contract owner's tests
  instead of a hand-copied approximation. `memoryStore` runs the same suite as the reference
  implementation.

  The metadata `append` and `open` take is now named — `AppendMeta` and `StreamMeta`, exported from
  the engine — rather than inlined on `SessionStore`.
  The suite pins a `Required<AppendMeta>` literal, which is what makes a new contract field
  impossible to add silently: the literal stops typechecking until it is filled in, and the
  round-trip assertions are driven off its own keys.

- d69bf1c: Extract the durable-execution engine into `@behalf-js/engine`.

  `graph/`, `session/`, `gateway/`, and `runtime/` now live in their own package, with the same `.`
  / `./internal` split core had. `@behalf-js/core` keeps `ai/` and re-exports the engine's whole
  surface, so existing imports are unchanged; a durable workflow with no AI in it can now depend on
  `@behalf-js/engine` alone. `@behalf-js/stores` and `@behalf-js/testing`'s root subpath do exactly
  that.

  Replay no longer recognizes a satisfied `waitFor` by matching the literal event type `"message"`.
  The extension that claims an inbox entry (`EngineExtension.commitInboxMessage`) now also claims it
  back out of the log (`EngineExtension.inboxMessageOf`), so the engine never names any extension's
  vocabulary.
