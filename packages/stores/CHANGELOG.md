# @behalf-js/stores

## 0.0.1

### Patch Changes

- Initial split of behalf into six scoped packages: `core` (flow authoring and the engine),
  `testing` (step-by-step test helpers and a fake model port), `models-anthropic`, `models-openai`
  (a stub whose `createOpenAIPort` throws "not implemented yet"), `tools` (the standard
  read/write/edit/bash bindings), and `stores` (an in-memory session store).
- Updated dependencies
  - @behalf-js/core@0.0.1
