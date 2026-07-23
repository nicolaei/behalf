# Steps and emits

A step is a node's body: the function that does the actual work. `StepContext` is what it sees; an
`Emit` is the one outcome it hands back.

## You will learn

- How to read `StepContext`'s `thread`, `inputs`, `modelCall`, and `callTool`
- How to choose between reading `context.inputs` and `context.thread.messages`
- How to return each of the four kinds of `Emit`: `output`, `compact`, `invalidate`, `error`
- How a `PersonaStep` differs from a plain `Step`

## StepContext

Every step runs with the same [`StepContext`](../../reference.md#stepcontext): the thread it's on,
the previous node's output, and the two effects a step can perform, `modelCall` and `callTool`.
`thread.messages` is the assembled view a model would see right now, compaction applied and old
messages trimmed; `thread.history` is the full record, compaction messages included.
Most steps only ever need `thread.messages`.

The example below is reference.md's own "reading input two ways" graph. `classify` calls the model,
then reads its reply off the thread:

```ts source=docs/examples/steps-and-emits/two-ways.ts#classify
  const classify = flow.step(async (context) => {
    await context.modelCall(classifier);
    return context.output(readLabel(context));
  });
```

`classifier` here is a `Profile`, a named persona: model, system prompt, tools.
[Describing a flow](../describing-a-flow/profiles-and-models.md) covers it properly; for now, treat
it as an opaque name you pass to `modelCall`. `modelCall` makes one request, runs any tools that
reply asks for, and appends all of it to the log, so by the time it resolves,
`context.thread.messages` already has the assistant's reply as its last entry.

## Reading input two ways

A step reads its work from one of two places: the conversation, or the previous node's exact output.
`route` reads the second one, differently from `classify`:

```ts source=docs/examples/steps-and-emits/two-ways.ts#route
  const route = flow.step(async (context) => {
    const label = context.inputs[0] as "bug" | "feature";
    return context.output(label === "bug" ? triagePlan : featurePlan);
  });
```

`context.inputs[0]` is the exact value `classify` just returned, not a message: no model saw it, no
round trip parsed it back out of text.
It's independent of `context.thread.messages`: one is filled by whatever the previous node returned,
the other by `modelCall`, the inbox, and compaction, never by a step's own `output`.

A step that needs the model's words reads the thread; one that needs the previous node's exact
result reads `inputs`. `route` never touches the thread at all: it doesn't need to, since `classify`
already boiled the model's reply down to one of two labels.

> [!TIP] `context.inputs` has one entry per branch at a join, not just one.
> [Joining](./wiring-a-graph.md#joining) covers reading more than one.

## The four Emits

A step always returns exactly one [`Emit`](../../reference.md#emit): `output`, `compact`,
`invalidate`, or `error`. `output` is the one edges route on: what `classify` and `route` both used
above.

`compact` replaces the thread's messages outright: a new turn, on the same thread, with a lighter
history.
It's how a long-running agent loop keeps its context from growing forever, covered fully in
[Wiring a runtime](../wiring-a-runtime/running-flows.md).

`invalidate` reruns a node the current edge doesn't lead back to: an interrupt or a step reaching
sideways into the graph, rather than following its own edges.
It takes the same `threadAction` vocabulary an edge does;
[Threads and forking](./threads-and-forking.md) covers choosing one.

`error` hands a failure to the runner instead of routing it through any edge.
No `when`/`otherwise` ever sees an `error`: the runtime's error handling decides what happens next,
covered in [Handling errors](../agents-in-practice/handling-errors.md).

> [!NOTE] Only `output` is routed by edges.
> The other three each have their own, separate path through the runtime.

## PersonaStep

A step that calls a model is a `PersonaStep`: it carries its own `persona` (the `Profile` it calls),
so the graph and its coverage check can see which models a flow actually needs, with no separate
registration step. `classify` above is one, since it builds its step around
`context.modelCall(classifier)`; `route` is a plain `Step`, since it never touches a model at all.

You won't usually write a `PersonaStep` by hand. `modelStep(profile)` (see
[reference.md § Step and PersonaStep](../../reference.md#step-and-personastep)) builds one for you,
and it's what an `agentTurn` loop is built from.
See [The agent loop](../agents-in-practice/the-agent-loop.md).

## Recap

- `StepContext` gives a step its `thread`, the previous node's `inputs`, and `modelCall`/`callTool`
- `context.inputs[0]` is the previous node's exact output; `context.thread.messages` is the
  conversation, independent, filled differently
- A step returns one `Emit`: `output` (routed by edges), `compact` (a lighter new turn),
  `invalidate` (rerun a node out of band), or `error` (handed to the runner)
- A `PersonaStep` carries its own `persona`, so the graph sees which models it needs with no
  separate registration
- Next: compose steps into a runnable graph, in [Wiring a graph](./wiring-a-graph.md)

---

**Reference:** reference.md § StepContext, § Step and PersonaStep, § Emit. **Examples:**
`docs/examples/steps-and-emits/two-ways.ts` (reference.md's own "reading input two ways" example),
regions: `classify`, `route`. **Section:** [Building the graph](./README.md) **Prev / Next:**
[Thinking in behalf](../get-started/thinking-in-behalf.md) / [Wiring a graph](./wiring-a-graph.md)
