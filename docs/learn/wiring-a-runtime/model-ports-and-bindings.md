# Model ports and bindings

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

A `ModelPort` adapts one provider so the engine can call it; tool bindings are how a runtime
supplies real `ToolHandler`s for the tools your personas declare.

## You will learn

- What a `ModelPort` must implement, and what "it only responds" means (compaction is a normal
  response with a summary prompt)
- Why a port passes `thinking` blocks back unmodified
- What it converts when a thread crosses providers
- How to assemble tool bindings from `standardBindings` plus your own
- How this connects to `fakePort` for tests (forward ref to Setting up fakes)

## ModelPort

_`model`, `respond(profile, messages, stream)`.
Example ref: `docs/examples/model-ports-and-bindings/sketch.ts#port`._

## Thinking blocks and retention

_Mutating a block's `signature` breaks it; retention is the provider's decision, not the port's —
reasoned generically, no provider named.
TODO._

## Tool bindings

_`[...standardBindings, ...authorBindings]`.
Example ref: `#bindings`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § ModelPort (incl. the two provider sketches), § Tool bindings.
**Examples:** `docs/examples/model-ports-and-bindings/sketch.ts` — regions: `port`, `bindings`.
**Section:** [Wiring a runtime](./README.md) **Prev / Next:** [Running flows](./running-flows.md) /
[Testing your flows](../testing/testing-your-flows.md)
