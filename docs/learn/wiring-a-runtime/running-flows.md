# Running flows

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

`runtime()` builds what a flow runs against; `runFlow()` seeds a session and drives it to
completion.

## You will learn

- How to assemble a `runtime`: model resolution, tool bindings, a store
- How `satisfiesFlows` checks coverage before you run anything, and what a `Missing` entry tells you
- How `runFlow` seeds a session with a message and resolves with the result
- How `parentThreadId` makes a spawned flow a child (how a tool spawns a sub-agent)

## Assembling a runtime

_`models`, `bindings`, `store`, optional `errorHandlers`.
Example ref: `docs/examples/running-flows/basic.ts#runtime`._

## The coverage gate

_`satisfiesFlows(flows, models, bindings, waitableSources?)` — walks every `step`/`interrupt`/`use`
node statically; empty means ready.
Example ref: `#coverage`._

## runFlow

_Seeds a new session, drives to completion, resolves with the terminal output.
Example ref: `#run`._

## Spawning a child flow

_`parentThreadId` — how `ToolContext.runFlow` spawns a sub-agent.
Forward ref to Tools and handlers.
TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § satisfiesPersonas / satisfiesFlows, § runtime / runFlow. **Examples:**
`docs/examples/running-flows/basic.ts` — regions: `runtime`, `coverage`, `run`. **Section:**
[Wiring a runtime](./README.md) **Prev / Next:**
[Handling errors](../agents-in-practice/handling-errors.md) /
[Model ports and bindings](./model-ports-and-bindings.md)
