# @behalf-js/models-anthropic

## 0.0.7

### Patch Changes

- c4dda16: Abort now cancels the real model call, not just the flow — provider-agnostic.

  Previously an aborted turn only ever raced the model call and walked away from it: the underlying
  network request kept running in the background, so a still-streaming real call kept calling
  `stream.delta()` after the flow had already moved on.
  Visually, an aborted reply kept growing after the abort "succeeded".
  Separately, an abort with no text streamed yet built an assistant message with an empty text
  content block, which a real provider's API rejects outright — breaking the very next prompt.

  `ModelPort.respond` gains an optional 4th parameter, `signal?: AbortSignal` — a standard Web API,
  not specific to any one provider.
  Every existing 3-arg port implementation keeps compiling and behaving exactly as before.
  `runModelCall` builds a real `AbortController` and threads its signal into `respond()`, calling
  `controller.abort()` (not just `stream.abort()`) when the abort branch wins the race, so a
  cooperative port's own transport actually stops.
  The losing reply promise may still settle later regardless — a real network call isn't guaranteed
  to die the instant `abort()` is called, and an uncooperative port can ignore the signal entirely —
  so its eventual settlement is silently caught purely to avoid an unhandled rejection; a genuine
  model-call failure, unrelated to any abort, still rejects and still propagates exactly as before.

  `createAnthropicPort` threads the signal into the SDK's own `RequestOptions`
  (`client.messages.stream(body, { signal })`). `createOpenAIPort`'s stub signature updated to
  match, for whenever it's implemented.

  `memoryStore`'s `Stream` gets a `settled` guard: `delta()`/`commit()` become no-ops once the
  stream already committed or aborted — defense in depth for the real-world gap between "abort()
  called" and "the network actually stops," and for any port that ignores the signal. `abort()`'s
  built message now uses an empty content array, not an empty text block, when nothing streamed
  before the abort.

- Updated dependencies [c4dda16]
  - @behalf-js/core@0.0.7

## 0.0.6

### Patch Changes

- Updated dependencies [dc58b7e]
  - @behalf-js/core@0.0.6

## 0.0.5

### Patch Changes

- Updated dependencies [69dfe48]
  - @behalf-js/core@0.0.5

## 0.0.4

### Patch Changes

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
