# Running flows

`runtime()` builds what a flow runs against; `runFlow()` seeds a session and drives it to
completion.

## You will learn

- How to assemble a `runtime`: model resolution, tool bindings, a store
- How `satisfiesFlows` checks coverage before you run anything, and what a `Missing` entry tells you
- How `runFlow` seeds a session with a message and resolves with the result
- How `parentThreadId` makes a spawned flow a child (how a tool spawns a sub-agent)

## Assembling a runtime

A flow's authored graph never touches a real model or a real disk.
It calls `context.modelCall(profile)` and reads `context.thread`, and leaves resolving those to
whatever runs it. `runtime()` is that supply: it holds a model resolver, the tool bindings, and a
session store, and hands back a `Runtime` every `runFlow` call reuses.

Here's a runtime built from a fake model port and an in-memory store:

```ts source=docs/examples/running-flows/basic.ts#runtime
export const ready = await runtime({
  models: () => fakePort,
  bindings: [],
  store: memoryStore(),
});
```

`models` is a function, not a value, because a flow can call more than one model across different
personas: `runtime()` calls it with whichever `Model` a `Profile` names and expects a `ModelPort`
back for it. `bindings` is empty here because this flow's persona declares no tools.
An optional fourth field, `errorHandlers`, is covered in
[Handling errors](../agents-in-practice/handling-errors.md); `runtime()` always appends its own
default retry handler after whatever you pass, so omitting it just means "use the default."

## The coverage gate

You might expect a missing tool binding to surface the first time a flow actually calls that tool,
mid-run.
Instead, `satisfiesFlows` checks every persona a set of flows could reach before you run anything,
by walking each flow's graph structure: every `step`, `interrupt`, and `use` node, recursing into a
subgraph the same way.
For each persona it finds, it checks three things: does the model resolver return a port for it, is
every declared tool bound, and does the model actually support the persona's requested reasoning
level.
An empty result means the flow is ready to run.

```ts source=docs/examples/running-flows/basic.ts#coverage
export const missing = satisfiesFlows([chat], () => fakePort, []);

// A persona that declares a tool with no matching binding, so satisfiesFlows
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

export const missingTool = satisfiesFlows([brokenChat], () => fakePort, []);
```

`missing` comes back empty: `chat`'s one persona has no tools and a port is registered for its
model. `missingTool` comes back `[{ kind: "tool", model: "fake", tool: "lookup_order" }]`:
`broken-chat`'s persona declares `lookup_order`, and no binding in the list provides it.
Boot your app with something like `if (missing.length) throw new Error(JSON.stringify(missing))`,
and a misconfigured deployment fails at startup with the exact gap named, not three turns into a
conversation with a user watching.

> [!NOTE] `satisfiesFlows` finds a persona by its step's own `.persona` tag, the same tag
> `context.modelCall`'s caller attaches by hand (see the example's `Object.assign`).
> It's a static check: nothing here calls a model or a tool.

## runFlow

Once coverage is clean, `runFlow` seeds a graph with one message and drives it to its result:

```ts source=docs/examples/running-flows/basic.ts#run-flow
export const result = await runFlow(chat, userText("Say hello."), ready);
```

`runFlow` opens a fresh thread, appends the seed message to the session log, and runs the graph
until it reaches `flow.finish`, resolving with whatever value reached it.
There's no separate `schedule` or `spawn` call: seeding and driving are the same step.

## Spawning a child flow

A tool handler's `ToolContext` carries its own `runFlow`, so a tool can start another flow instead
of just returning a value: a "delegate to a sub-agent" tool calls
`context.runFlow(reviewFlow, prompt)` and awaits its result the same way any async call would.

That inner call passes the parent thread's id along as `parentThreadId`, which is what makes the new
flow a child rather than an unrelated run: `parentThreadId` is ownership (this thread exists because
that one spawned it), distinct from `fork` (a `ThreadAction` that shares history up to a split
point).
The full mechanics, including how a tool handler reads its own `correlationId` to correlate the
spawn with its result, live in [Tools and handlers](../describing-a-flow/tools-and-handlers.md).

## Recap

- `runtime()` holds a model resolver, tool bindings, and a store; `bindings` covers only the tools
  your personas actually declare
- `satisfiesFlows` walks a flow's structure statically (`step`/`interrupt`/`use`, recursing into
  subgraphs) and reports every `Missing` model, tool, or reasoning level; empty means ready
- `runFlow` seeds a new thread with a message, drives the graph to `flow.finish`, and resolves with
  its output
- A tool spawns a child flow through `ToolContext.runFlow`, with `parentThreadId` marking the
  ownership
- Next: implement a `ModelPort` and assemble the bindings a runtime needs, in
  [Model ports and bindings](./model-ports-and-bindings.md)

---

**Reference:** reference.md § satisfiesPersonas / satisfiesFlows, § runtime / runFlow. **Examples:**
`docs/examples/running-flows/basic.ts`, regions `runtime`, `coverage`, `run-flow`. **Section:**
[Wiring a runtime](./README.md) **Prev / Next:**
[Handling errors](../agents-in-practice/handling-errors.md) /
[Model ports and bindings](./model-ports-and-bindings.md)
