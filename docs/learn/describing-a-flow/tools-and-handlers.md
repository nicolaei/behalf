# Tools and handlers

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

A `tool` declares one typed capability; a `ToolHandler` implements it;
`provide`/`expand` bind the two together.

## You will learn

- The difference between a `tool` and a `toolset`
- How to write a `ToolHandler` and what its `ToolContext` gives it
- How `provide` binds a `tool` and `expand` binds a `toolset`
- How a handler streams progress
- How a handler spawns a child flow

## Declaring a tool

_`tool<Input, Output>(name, describe)`; `toolset` for MCP/curated bundles.
Example ref: `docs/examples/tools-and-handlers/search-tool.ts#tool`._

## Writing a handler

_Input + `ToolContext` in, `Output` out; idempotency is the handler's own
concern since it may re-run on resume. Example ref: `#handler`._

## Binding: provide and expand

_Mixing them is a compile error. Example ref: `#binding`._

## Streaming progress and spawning a sub-flow

_`context.openStream`, `context.runFlow` — brief, forward ref to Streaming
progress and Running flows. TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § tool / toolset, § ToolHandler, § provide / expand.
**Examples:** `docs/examples/tools-and-handlers/search-tool.ts` — regions: `tool`, `handler`, `binding`.
**Section:** [Describing a flow](./README.md)
**Prev / Next:** [Profiles and models](./profiles-and-models.md) / [The agent loop](../agents-in-practice/the-agent-loop.md)
