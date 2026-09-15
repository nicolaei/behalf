# @behalf-js/testing

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

### Patch Changes

- Updated dependencies [1fa42c6]
- Updated dependencies [b2cdcf9]
- Updated dependencies [7621720]
- Updated dependencies [d69bf1c]
  - @behalf-js/core@0.1.0
  - @behalf-js/engine@0.1.0
  - @behalf-js/stores@0.1.0

## 0.0.10

### Patch Changes

- Updated dependencies [669ab73]
  - @behalf-js/core@0.0.10
  - @behalf-js/stores@0.0.10

## 0.0.9

### Patch Changes

- Updated dependencies [7f054cd]
  - @behalf-js/core@0.0.9
  - @behalf-js/stores@0.0.9

## 0.0.8

### Patch Changes

- Updated dependencies [d368531]
  - @behalf-js/core@0.0.8
  - @behalf-js/stores@0.0.8

## 0.0.7

### Patch Changes

- Updated dependencies [c4dda16]
  - @behalf-js/core@0.0.7
  - @behalf-js/stores@0.0.7

## 0.0.6

### Patch Changes

- Updated dependencies [dc58b7e]
  - @behalf-js/core@0.0.6
  - @behalf-js/stores@0.0.6

## 0.0.5

### Patch Changes

- Updated dependencies [69dfe48]
  - @behalf-js/core@0.0.5
  - @behalf-js/stores@0.0.5

## 0.0.4

### Patch Changes

- 84e6e6e: New `@behalf-js/testing/eval` subpath export: a persona/quality evaluation harness for
  scoring behalf flows across cases, separate from the existing
  `stepOnce`/`stepUntilBlocked`/`stepUntil` flow-testing vocabulary.
  Adds `scenario`/`explore` for defining and running cases against a `Subject` (`agent`),
  `example`/`Fixtures` for case data, scorers (`toolCalled`, `toolCalledWith`, `worldMatches`,
  `outputMatches`, `saidOn`, `scoreBy`), an `llmJudge` for model-graded scoring, regression-checking
  (`variance`/`fixed`/`checkRegression`, `jsonlBaselineStore`), and harness utilities (`gate`,
  `aggregate`, `grid`
  - ranking by score/time/tokens/cost).
    Not re-exported from the package's top-level `index` — opt in explicitly via the `/eval`
    subpath.
- Updated dependencies [0c2cb7c]
- Updated dependencies [84e6e6e]
  - @behalf-js/core@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [8349bac]
  - @behalf-js/core@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [e97ed59]
  - @behalf-js/core@0.0.2

## 0.0.1

### Patch Changes

- Initial split of behalf into six scoped packages: `core` (flow authoring and the engine),
  `testing` (step-by-step test helpers and a fake model port), `models-anthropic`, `models-openai`
  (a stub whose `createOpenAIPort` throws "not implemented yet"), `tools` (the standard
  read/write/edit/bash bindings), and `stores` (an in-memory session store).
- Updated dependencies
  - @behalf-js/core@0.0.1
