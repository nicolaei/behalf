# Setting up fakes

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

`fakePort` and a fake tool binding let you exercise a whole flow — routing, threading, compaction —
without calling a real model.

## You will learn

- How `fakePort` behaves by default and when to reach for it
- How to script a different response per test case
- How to fake a tool binding with `provide`
- How to combine fakes with `stepUntilBlocked`/`runFlow` from the previous page

## fakePort

_Always replies with fixed text, no tool calls.
Example ref: `docs/examples/setting-up-fakes/fake-chat.test.ts#fake-port`._

## Scripting responses

_A `ModelPort` whose `respond` reads a per-test script/queue.
Example ref: `#scripted-port`._

## Faking a tool

_`provide(tool, async () => (...))`.
Example ref: `#fake-tool`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § ModelPort (fakePort sketch), § Full examples #1 under "Systems running
flows" (all-fakes test). **Examples:** `docs/examples/setting-up-fakes/fake-chat.test.ts` — regions:
`fake-port`, `scripted-port`, `fake-tool`. **Section:** [Testing](./README.md) **Prev / Next:**
[Testing your flows](./testing-your-flows.md) / [Evaluating personas](./evaluating-personas.md)
