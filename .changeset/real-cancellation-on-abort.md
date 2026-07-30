---
"@behalf-js/core": patch
"@behalf-js/stores": patch
"@behalf-js/models-anthropic": patch
"@behalf-js/models-openai": patch
---

Abort now cancels the real model call, not just the flow — provider-agnostic.

Previously an aborted turn only ever raced the model call and walked away from it: the
underlying network request kept running in the background, so a still-streaming real call kept
calling `stream.delta()` after the flow had already moved on. Visually, an aborted reply kept
growing after the abort "succeeded". Separately, an abort with no text streamed yet built an
assistant message with an empty text content block, which a real provider's API rejects outright
— breaking the very next prompt.

`ModelPort.respond` gains an optional 4th parameter, `signal?: AbortSignal` — a standard Web API,
not specific to any one provider. Every existing 3-arg port implementation keeps compiling and
behaving exactly as before. `runModelCall` builds a real `AbortController` and threads its signal
into `respond()`, calling `controller.abort()` (not just `stream.abort()`) when the abort branch
wins the race, so a cooperative port's own transport actually stops. The losing reply promise may
still settle later regardless — a real network call isn't guaranteed to die the instant `abort()`
is called, and an uncooperative port can ignore the signal entirely — so its eventual settlement
is silently caught purely to avoid an unhandled rejection; a genuine model-call failure, unrelated
to any abort, still rejects and still propagates exactly as before.

`createAnthropicPort` threads the signal into the SDK's own `RequestOptions`
(`client.messages.stream(body, { signal })`). `createOpenAIPort`'s stub signature updated to
match, for whenever it's implemented.

`memoryStore`'s `Stream` gets a `settled` guard: `delta()`/`commit()` become no-ops once the
stream already committed or aborted — defense in depth for the real-world gap between "abort()
called" and "the network actually stops," and for any port that ignores the signal. `abort()`'s
built message now uses an empty content array, not an empty text block, when nothing streamed
before the abort.
