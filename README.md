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
import { agentTurn, userText, runtime, runFlow, adapters } from "behalf";
import type { Profile, Model } from "behalf";

const sonnet5: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off", "medium"],
};

// `standardBindings` pairs each default tool (read, write, edit, bash) with a
// working handler. `Profile.tools` wants the bare descriptors, so pull `.tool`
// (or `.toolset`) out of each binding.
const { standardBindings } = adapters.tools;
const defaultTools = standardBindings.map((binding) =>
  binding.kind === "tool" ? binding.tool : binding.toolset,
);

const assistant: Profile = {
  model: sonnet5,
  system: "You are a helpful assistant.",
  tools: defaultTools,
};

// `agentTurn` is itself a graph: run the model, resolve whatever tools it
// calls, loop back until a reply uses no tools. A real chat wraps this in
// `flow.waitFor(userInput("follow-up"))` to take a next prompt on the same
// thread (see docs/learn/agents-in-practice). This is the one turn on its own.
export const support = agentTurn(assistant);

async function main() {
  const ready = await runtime({
    models: () => adapters.models.createAnthropicPort(sonnet5),
    bindings: standardBindings,
    store: adapters.stores.memoryStore(),
  });

  const result = await runFlow(support, userText("List the files in this directory."), ready);
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## Runnable examples

Full standalone apps, each with its own `package.json`, as distinct from the
small doc fragments under `docs/examples/` (meant to be read, not run):

- **[`examples/simple-chat`](./examples/simple-chat/)**: a terminal chat
  agent. Real Anthropic streaming and real filesystem tools, no mocks.
- **[`examples/multi-step-agent`](./examples/multi-step-agent/)**: a
  four-stage pipeline, asker → red → green → refactor, that interviews you
  for a spec, then writes a failing test, makes it pass, and refactors it.

Each has its own README with setup and auth. From the repo root:

```sh
npm install
npm run build
cd examples/simple-chat  # or examples/multi-step-agent
npm install
npm start
```

## Documentation

- **[Learn](./docs/learn/README.md)** walks through the library's concepts,
  in order: get started, describing a flow, building the graph, agents in
  practice, wiring a runtime, testing, streaming and sessions.
- **[Reference](./docs/reference.md)** documents every interface, signature,
  and worked example, for when you already know what you're looking for.

## Status

Pre-1.0 and unpublished (`private: true`, `0.0.0`). The API is still moving;
expect breaking changes without notice until this note goes away.
