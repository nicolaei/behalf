# Quick start

Install behalf, describe a persona, wire the smallest possible graph, and run one turn: the fastest
path from nothing to a working reply.

## You will learn

- How to install behalf and which package holds what
- How to describe a `Profile` (model, system prompt, tools)
- How to wire a one-step graph: `entry`, a step, `finish`
- How to run it with `runtime()` and `runFlow()` and see the reply

## Install

behalf ships as six scoped packages under `@behalf-js/*` instead of one.
Most flows only need three of them: `core` for the graph itself, one `models-*` package for
whichever provider you're calling, and `stores` for where the session log lives.

```bash
npm install @behalf-js/core @behalf-js/models-anthropic @behalf-js/stores
```

> [!NOTE] `@behalf-js/testing` and `@behalf-js/tools` aren't in this list.
> Add `testing` once you start writing tests for your own flows (see
> [Testing](../testing/README.md)); add `tools` if you want the built-in filesystem/shell tool
> handlers instead of writing your own.

## Describe a persona

A `Profile` is a persona: the model it calls, its system prompt, and the tools it may use.
This one has no tools, since this first flow only needs a plain reply.

```ts source=docs/examples/quick-start/basic.ts#profile
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
```

`reasoning` lists the levels this model actually supports; a `Profile` can only ask for one of them,
checked at boot rather than failing mid-run.
See [Profiles and models](../describing-a-flow/profiles-and-models.md) for the full shape.

## Wire the graph

A graph is nodes and edges, built once inside `defineGraph`'s callback.
The smallest one worth having is a single turn: enter, run the persona, finish.

```ts source=docs/examples/quick-start/basic.ts#graph
export const workflow = defineGraph("quick-start", (flow) => {
  const turn = flow.use(agentTurn(assistant));
  flow.entry(turn);
  turn.then(flow.finish);
});
```

`agentTurn` is a reusable graph, not a special case: `flow.use()` composes it as a single node, the
same way you'd compose any other graph you'd built yourself.
It runs the model, waits out any tool calls, and loops until a final message arrives.
With `tools: []` above, there's nothing to wait for: it calls the model once and finishes
immediately.

## Run it

`runtime()` builds the pieces every flow runs against: how to resolve a model, what tools are bound,
and where the session log lives. `runFlow()` seeds a graph with one message and drives it to its
result.

```ts source=docs/examples/quick-start/basic.ts#run
const ready = await runtime({
  models: () => createAnthropicPort(sonnet5),
  bindings: [],
  store: memoryStore(),
});

const result = await runFlow(workflow, userText("Say hello world in one sentence."), ready);
console.log(result);
```

`models` is a function, not a value, because a flow can call more than one model across different
personas; `runtime()` calls it with whichever `Model` a `Profile` names and expects back a
`ModelPort` for it.
Here there's only one model, so it ignores the argument and always returns the same port.

Run this with a real `ANTHROPIC_API_KEY` in your environment and it prints the model's reply.
Swap `createAnthropicPort`/`memoryStore` for [`fakePort`](../testing/setting-up-fakes.md) and an
in-memory assertion once you want to test a flow instead of running it live.

## Recap

- behalf ships as six `@behalf-js/*` packages; most flows need `core`, one `models-*` adapter, and
  `stores`
- A `Profile` is a model, a system prompt, and its tools
- `defineGraph` builds a graph once from a callback; `flow.use()` composes a reusable graph
  (`agentTurn`) as a single node
- `runtime()` resolves models and holds the session store; `runFlow()` seeds a message and drives to
  a result
- Next: design a flow of your own, from a blank page, using the same methodology, in
  [Thinking in behalf](./thinking-in-behalf.md)

---

**Reference:** [`Profile`](../../reference.md), [`defineGraph`](../../reference.md),
[`runtime`/`runFlow`](../../reference.md). **Examples:** `docs/examples/quick-start/basic.ts`,
regions `profile`, `graph`, `run` (also the README's own quick start snippet, sourced from the same
file). **Section:** [Get started](./README.md) **Next:**
[Thinking in behalf](./thinking-in-behalf.md)
