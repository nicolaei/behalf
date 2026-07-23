# Behalf

> **behalf** _noun_
>
> 1. acting on behalf of someone: representing them, acting as their
> authorized agent, or working for their benefit.
> 2. _(of software)_ an autonomous system executing tasks and making
> decisions under delegated user authority.

Behalf is a TypeScript library for building agent workflows as code — a graph
of typed, testable steps, not a stack of natural-language instructions.

Most agent behavior today lives in **skills**: prose files telling a model
what to do. Skills are easy to write and hard to make deterministic — you
can't typecheck a paragraph, or unit-test an instruction. Behalf represents
that behavior as a graph of steps instead — a persona calling a model, a
tool running, a wait for input. A single skill, a whole workflow, and a
multi-agent system are all just this one shape, at any scale.

- **Testable** — a flow is code: typechecked, unit-tested, steppable one
  node at a time.
- **Evaluable** — scoring a persona or checking a flow's coverage is a
  normal test, not a prompt review.
- **Composable** — `use()` embeds one graph inside another, so a step, a
  workflow, and a system built from many workflows are the same shape.

## Get started

```bash
npm install behalf
```

```ts
import { defineGraph, agentTurn, userInput } from "behalf";

// `assistant` is a Profile — a model, a system prompt, and its tools
// (see docs/learn/describing-a-flow). One persona, looped until it replies
// without using a tool, waiting for the next prompt between turns — an
// entire interactive chat, expressed as a graph.
export const chat = defineGraph("chat", (flow) => {
  const turn = flow.use(agentTurn(assistant));
  const wait = flow.waitFor(userInput("follow-up"));
  flow.entry(turn);
  turn.then(wait);
  wait.then(turn);
});
```

## Documentation

- **[Learn](./docs/learn/README.md)** — a guided path through the library's
  concepts, in order: get started, describing a flow, building the graph,
  agents in practice, wiring a runtime, testing, streaming and sessions.
- **[Reference](./docs/reference.md)** — every interface, signature, and
  worked example, for when you already know what you're looking for.

## Status

Pre-1.0 and unpublished (`private: true`, `0.0.0`). The API is still moving;
expect breaking changes without notice until this note goes away.
