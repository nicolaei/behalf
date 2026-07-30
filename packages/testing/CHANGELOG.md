# @behalf-js/testing

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
