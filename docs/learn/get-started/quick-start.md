# Quick start

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

Install behalf, describe a persona, wire the smallest possible graph, and run
one turn — the fastest path from nothing to a working reply.

## You will learn

- How to install behalf and what its entry point exports
- How to describe a `Profile` (model, system prompt, tools)
- How to wire a one-step graph: `entry`, a step, `finish`
- How to run it with `runtime()` and `runFlow()` and see the reply

## Install

_One command, one sentence on what "private": true / the entry point means for
consumers — TODO._

## Describe a persona

_A minimal `Profile` — model + system + empty tools. Example ref:
`docs/examples/quick-start/basic.ts#profile`._

## Wire the graph

_The smallest `defineGraph`: one step, `flow.entry`, `flow.finish`. Example
ref: `#graph`._

## Run it

_`runtime({ models, bindings: [], store })` then `runFlow(...)`. Example ref:
`#run`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Profile, § defineGraph, § runtime/runFlow.
**Examples:** `docs/examples/quick-start/basic.ts` — regions: `profile`, `graph`, `run`; plus a "Full example" block for the whole file.
**Section:** [Get started](./README.md)
**Next:** [Thinking in behalf](./thinking-in-behalf.md)
