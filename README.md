# Behalf

> **behalf** _noun_
>
> 1. acting on behalf of someone: representing them, acting as their
> authorized agent, or working for their benefit.
> 2. _(of software)_ an autonomous system executing tasks and making
> decisions under delegated user authority.

Behalf is a TypeScript library for building agents as code.

Most agent behavior today lives in **skills**: prose files telling a model what to do.
Skills are easy to write and hard to make deterministic and reason about.

You can't typecheck a paragraph, or unit-test an instruction.

Behalf represents that behavior as a graph of steps instead,
with data to represent agents and tools.

A skill for coding might turn into a single agent, or multiple agents in a workflow.
And any of these collections of agents can themselves be composed.

## Get started

```bash
npm install behalf
```

```ts
import { defineGraph, agentTurn, userText, runtime, runFlow, adapters } from "behalf";
import type { Profile, Model } from "behalf";

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

// `agentTurn(assistant)` is itself a graph. `flow.use` composes it as one
// node here, so `support` is a graph too, just one node deep for now.
export const support = defineGraph("support", (flow) => {
  const turn = flow.use(agentTurn(assistant));
  flow.entry(turn);
  turn.then(flow.finish);
});

const ready = await runtime({
  models: () => adapters.models.createAnthropicPort(sonnet5),
  bindings: [],
  store: adapters.stores.memoryStore(),
});

const result = await runFlow(support, userText("Say hello in one sentence."), ready);
console.log(result);
```

## Runnable examples

- **[`Simple Chat`](./examples/simple-chat/)**: a terminal chat with tools.
- **[`Multi Step Agent`](./examples/multi-step-agent/)**:
  a four-stage coding pipeline that interviews you for a spec,
  then writes a failing test, makes it pass, and refactors it.

## Documentation

- **[Learn](./docs/learn/README.md)** walks through the library's concepts,
  in order: get started, describing a flow, building the graph, agents in
  practice, wiring a runtime, testing, streaming and sessions.
- **[Reference](./docs/reference.md)** documents every interface, signature,
  and worked example, for when you already know what you're looking for.

## Status

Pre-1.0 and unpublished (`private: true`, `0.0.0`). The API is still moving;
expect breaking changes without notice until this note goes away.
