# @behalf-js/models-anthropic

## 0.1.1

### Patch Changes

- 71df56f: Raise `CLAUDE_CODE_VERSION` from `2.1.75` to `2.1.280`.

  The API gates OAuth traffic per model by the version in the request's user-agent:
  `claude-opus-5-5` rejects anything below `2.1.280` with `400 invalid_request_error` /
  `error_code "claude_code_version_too_old"`, and answers `200` once the user-agent reports
  `2.1.280`. `2.1.280` is both the minimum the API names and the version the working client on this
  machine announces, so the constant cannot be lowered without bringing the refusal back.
  The beta flags, the identity block and the tool surface are unchanged.

- 4418ff5: Send another provider's thinking as text.

  A session whose history was written by another provider (say, a model on OpenRouter) and is then
  resumed on Anthropic replayed that provider's thinking blocks as `thinking`.
  Anthropic cannot verify their signature and rejected every request with a 400: "Invalid
  `signature` in `thinking` block" — the session was stuck for good.
  Thinking from a non-Anthropic assistant turn now goes as plain text, and a block with no words is
  dropped.

- b85c7b5: Resolve package entry points to source in the workspace, dist in the tarball.

  Every package's `exports` now points at `./src/*.ts` in the checkout, so in-repo consumers — this
  workspace's tests and cockpit's `file:` dependencies — need no build step. `prepack`/`postpack`
  run a new `tools/pack-manifest.mjs` to swap those entries to `{ types, default }` dist objects
  while packing, and back to source afterward, so published tarballs still ship compiled `./dist`
  output.

- Updated dependencies [b85c7b5]
  - @behalf-js/core@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [1fa42c6]
- Updated dependencies [b2cdcf9]
- Updated dependencies [7621720]
- Updated dependencies [d69bf1c]
  - @behalf-js/core@0.1.0

## 0.0.10

### Patch Changes

- Updated dependencies [669ab73]
  - @behalf-js/core@0.0.10

## 0.0.9

### Patch Changes

- Updated dependencies [7f054cd]
  - @behalf-js/core@0.0.9

## 0.0.8

### Patch Changes

- Updated dependencies [d368531]
  - @behalf-js/core@0.0.8

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
