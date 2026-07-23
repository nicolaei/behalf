# Behalf

> **behalf** _noun_
>
> 1. acting on behalf of someone: representing them, acting as their authorized agent, or working
>    for their benefit.
> 2. _(of software)_ an autonomous system executing tasks and making decisions under delegated user
>    authority.

Behalf is a TypeScript library for building agents as code.

Most agent behavior today lives in **skills**: prose files telling a model what to do.
Skills are easy to write and hard to make deterministic and reason about.
You can't typecheck a paragraph, or unit-test an instruction.

Behalf represents that behavior as a graph of steps instead, with data to represent agents and
tools.

A skill for coding might turn into a single agent, or multiple agents in a workflow.
And any of these collections of agents can themselves be composed.

## Get started

```bash
npm install @behalf-js/core @behalf-js/models-anthropic @behalf-js/stores
```

```ts source=docs/examples/readme/quick-start.ts
import { defineGraph, agentTurn, userText, runtime, runFlow } from "@behalf-js/core";
import type { Profile, Model } from "@behalf-js/core";
import { createAnthropicPort } from "@behalf-js/models-anthropic";
import { memoryStore } from "@behalf-js/stores";

const sonnet5: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off", "medium"],
};

const assistant: Profile = {
  model: sonnet5,
  system: "You are a helpful assistant.",
  tools: [],
};

export const workflow = defineGraph("support", (flow) => {
  const turn = flow.use(agentTurn(assistant));
  flow.entry(turn);
  turn.then(flow.finish);
});

const ready = await runtime({
  models: () => createAnthropicPort(sonnet5),
  bindings: [],
  store: memoryStore(),
});

const result = await runFlow(workflow, userText("Say hello world in one sentence."), ready);
console.log(result);
```

## Runnable examples

- **[Simple chat](./examples/simple-chat/)**: a terminal chat with tools.
- **[Multi step agent](./examples/multi-step-agent/)**: a four-stage coding pipeline that interviews
  you for a spec, then writes a failing test, makes it pass, and refactors it.

## Documentation

- **[Learn](./docs/learn/README.md)** walks through the library's concepts, in order: get started,
  describing a flow, building the graph, agents in practice, wiring a runtime, testing, streaming
  and sessions.
- **[Reference](./docs/reference.md)** documents every interface, signature, and worked example, for
  when you already know what you're looking for.

## Status

Pre-1.0 and not yet published.
Six packages under `@behalf-js/*`, all versioned together at `0.0.x`.
The API is still moving; expect breaking changes without notice until this note goes away.
