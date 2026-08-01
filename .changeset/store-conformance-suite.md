---
"@behalf-js/engine": minor
"@behalf-js/core": minor
"@behalf-js/testing": minor
---

Ship a reusable `SessionStore` conformance suite from `@behalf-js/testing`.

`sessionStoreConformance(name, makeStore)` registers the whole `SessionStore` contract as a vitest
`describe` block, so a host that writes its own store checks it against the contract owner's tests
instead of a hand-copied approximation. `memoryStore` runs the same suite as the reference
implementation.

The metadata `append` and `open` take is now named — `AppendMeta` and `StreamMeta`, exported from
the engine — rather than inlined on `SessionStore`.
The suite pins a `Required<AppendMeta>` literal, which is what makes a new contract field impossible
to add silently: the literal stops typechecking until it is filled in, and the round-trip assertions
are driven off its own keys.
