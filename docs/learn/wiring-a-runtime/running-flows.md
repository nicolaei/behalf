# Running flows

`runtime()` builds what a flow runs against; `seed()` starts a session and `driveFlow()` drives it
to completion.

## You will learn

- How to assemble a `runtime`: a store, plus the `ai` extension for model resolution and tool
  bindings
- How `satisfiesFlows` checks a flow's structure and `satisfiesPersonas` checks its personas, and
  what a `Missing` entry tells you
- How `seed` starts a session with a message and `driveFlow` drives it to its result
- How `spawnAgent` starts a child agent (how a tool delegates to a sub-agent)

## Assembling a runtime

A flow's authored graph never touches a real model or a real disk.
It calls `context.modelCall(profile)` and reads `context.thread`, and leaves resolving those to
whatever runs it. `runtime()` itself only holds a store, error handlers, and registered extensions;
model resolution and tool bindings are the `ai` extension's job, passed in through `extensions`.

Here's a runtime built from a fake model port and an in-memory store:

```ts source=docs/examples/running-flows/basic.ts#runtime
export const ready = await runtime({
  store: memoryStore(),
  extensions: [ai({ models: () => fakePort, bindings: [] })],
});
```

`models` is a function, not a value, because a flow can call more than one model across different
personas: `ai()` calls it with whichever `Model` a `Profile` names and expects a `ModelPort` back
for it. `bindings` is empty here because this flow's persona declares no tools.
An optional `errorHandlers` field on `runtime()` itself is covered in
[Handling errors](../agents-in-practice/handling-errors.md); `runtime()` always appends its own
default retry handler after whatever you pass, so omitting it just means "use the default."

## The coverage gate

You might expect a missing tool binding to surface the first time a flow actually calls that tool,
mid-run.
Instead, two functions check everything a flow could reach before you run anything, by walking its
graph structure: every `step`, `interrupt`, `waitFor`, and `use` node, recursing into a subgraph the
same way.

`satisfiesFlows` is the graph-shape half: it collects every `waitFor`/`interrupt` provider and
checks each against a `waitableSources` resolver, an optional second argument — `"userInput"` is
always satisfied, since it needs no registered source, but any other provider missing one is
reported too.
It has no model or binding awareness at all.

`satisfiesPersonas` is the model/binding half: given a flow and `{ models, bindings }` (the same
shape `ai()` takes), it finds every persona the flow could reach and checks three things per
persona: does the model resolver return a port for it, is every declared tool bound, and does the
model actually support the persona's requested reasoning level.

Both return a `Missing[]`; an empty result means that half is ready.

Here's a persona coverage check against `chat` (clean) and a deliberately broken flow whose persona
declares a tool with no matching binding, so you can see a real `Missing` entry instead of a
described one:

```ts source=docs/examples/running-flows/basic.ts#coverage
export const missing = satisfiesPersonas(chat, { models: () => fakePort, bindings: [] });

// A persona that declares a tool with no matching binding, so satisfiesPersonas
// has something real to report.
const lookupOrder = tool<{ orderId: string }, { status: string }>(
  "lookup_order",
  "Looks up an order's shipping status by id",
);
const needsLookup: Profile = { model: fakePort.model, system: "support", tools: [lookupOrder] };
const brokenRespond = Object.assign(
  async (context: StepContext) => {
    await context.modelCall(needsLookup);
    return context.output({ reply: lastAssistantText(context) });
  },
  { persona: needsLookup },
);
const brokenChat: Graph = defineGraph("broken-chat", (flow) => {
  const turn = flow.step(brokenRespond);
  flow.entry(turn);
  turn.then(flow.finish);
});

export const missingTool = satisfiesPersonas(brokenChat, { models: () => fakePort, bindings: [] });
```

`missing` comes back empty: `chat`'s one persona has no tools and a port is registered for its
model. `missingTool` comes back `[{ kind: "tool", model: "fake", tool: "lookup_order" }]`:
`broken-chat`'s persona declares `lookup_order`, and no binding in the list provides it.
Boot your app with something like `if (missing.length) throw new Error(JSON.stringify(missing))`,
and a misconfigured deployment fails at startup with the exact gap named, not three turns into a
conversation with a user watching.

> [!NOTE] `satisfiesPersonas` finds a persona by its step's own `.persona` tag, the same tag
> `context.modelCall`'s caller attaches by hand (see the example's `Object.assign`).
> It's a static check: nothing here calls a model or a tool.

## seed and driveFlow

Once coverage is clean, `seed` records the session's first message and `driveFlow` runs it to its
result:

```ts source=docs/examples/running-flows/basic.ts#run-flow
seed(chat, userText("Say hello."), ready);
export const result = await driveFlow(chat, ready);
```

`seed` mints a fresh thread and appends the starting message to the session log as its first durable
fact. `driveFlow` then advances the graph until it reaches `flow.finish`, resolving with whatever
value reached it — and along the way it parks whenever there's nothing to advance, waking on the
next thing the store receives.
That pairing is what makes a long-lived session work: the same call keeps resuming across as many
turns as the session needs.

## Spawning a child agent

A tool handler's `ToolContext` carries `spawnAgent`, so a tool can start another agent instead of
just returning a value: a "delegate to a sub-agent" tool calls
`context.spawnAgent(reviewFlow, prompt)` and awaits `handle.result()` the same way any async call
would.

A spawned agent is a child _session_, with its own store and its own log — not a second thread
inside the parent's.
That's what keeps the two independently resumable: a session's position is reconstructed from its
whole log, so two agents sharing one log would each read the other's events as their own.

The spawn is idempotent by the tool call's own `correlationId`, so a call re-dispatched after a
restart attaches to the child already running rather than starting a second one.
The full mechanics live in [Tools and handlers](../describing-a-flow/tools-and-handlers.md).

## Recap

- `runtime()` holds a model resolver, tool bindings, and a store; `bindings` covers only the tools
  your personas actually declare
- `satisfiesFlows` walks a flow's structure statically and reports every `Missing` unregistered
  `waitFor` provider; `satisfiesPersonas` does the same walk for personas, reporting every missing
  model, tool, or reasoning level; empty means ready
- `seed` records a new session's first message and mints its scope; `driveFlow` advances the graph
  to `flow.finish` and resolves with its output
- A tool spawns a child agent through `ToolContext.spawnAgent`, which is a separate session with its
  own log
- Next: implement a `ModelPort` and assemble the bindings a runtime needs, in
  [Model ports and bindings](./model-ports-and-bindings.md)

---

**Reference:** reference.md § satisfiesFlows / satisfiesPersonas, § runtime / seed / driveFlow, §
ai. **Examples:** `docs/examples/running-flows/basic.ts`, regions `runtime`, `coverage`, `run-flow`.
**Section:** [Wiring a runtime](./README.md) **Prev / Next:**
[Handling errors](../agents-in-practice/handling-errors.md) /
[Model ports and bindings](./model-ports-and-bindings.md)
