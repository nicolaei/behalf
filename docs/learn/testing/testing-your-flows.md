# Testing your flows

`behalf/testing` wraps the engine's internal `tick`/`tickUntilSuspended` in a test author's own
vocabulary, the same way a fake-timer library wraps a runtime's clock.

## You will learn

- How to recognize when a test needs `@behalf-js/testing` instead of `src/index.ts`
- How to choose between `stepOnce` and `stepUntilBlocked`
- How `stepUntil` plus `atNode` drives a flow to a specific point
- What `StepUntilError` tells you when a flow stalls or exceeds its budget

## Why a separate entry point

`runFlow` drives a flow straight to its result: fine for production, but a test that wants to assert
partway through a run needs to see the flow mid-flight, one node at a time.
The engine's own primitives for that, `tick` and `tickUntilSuspended`, work in terms of
`CursorState` and `parent`: internal bookkeeping for how the engine tracks a fan-out branch, not
vocabulary a test author should need to learn.

`@behalf-js/testing` wraps them once: `StepState` instead of `CursorState`, `laneId` instead of a
raw parent pointer.
It's the same move a fake-timer library makes over a runtime's own clock: purpose-built verbs
(`advanceTimersByTime`, `runAllTimers`) instead of the clock's own internals.
That's also why it's its own package import, `@behalf-js/testing`, not part of `@behalf-js/core`'s
main entry: a flow author never needs it, only a test author does.

## Stepping one node at a time

`stepOnce` advances every independently-progressing lane in a flow by one node and returns a
`StepResult`: one `StepState` per lane, so a fan-out's branches each get their own entry.
A plain linear flow only ever has one lane; a fan-out is where stepping one node at a time starts to
matter, since each branch moves at its own pace.

The example below fans out from `start` into two branches: `fast`, which finishes on its own, and
`humanReply`, which parks until a `"resume"` message arrives.
Both fold into `merge` before the flow finishes.

```ts source=docs/examples/testing-your-flows/step-through.ts#step-once
export let mergeNode: Handle;
export let fastNode: Handle;
export let humanReplyNode: Handle;

export const pipeline: Graph = defineGraph("step-through", (flow) => {
  const start = flow.step(
    outputs(() => "go"),
    { label: "start" },
  );
  const fast = flow.step(
    outputs(() => "fast-done"),
    { label: "fast" },
  );
  fastNode = fast;
  const humanReply = flow.waitFor(userInput("resume"));
  humanReplyNode = humanReply;
  const merge = flow.step(
    join((context) => context.inputs),
    { label: "merge" },
  );
  mergeNode = merge;

  flow.entry(start);
  start.then([fast, humanReply]);
  fast.then(merge);
  humanReply.then(merge);
  merge.then(flow.finish);
});

export async function stepOnceDemo() {
  const ready = await runtime({ models: () => fakePort, bindings: [], store: memoryStore() });
  return stepOnce(pipeline, ready);
}
```

One call to `stepOnce` here already runs `start` and fans out: the result holds two lanes, `fast`
and `humanReply`, both `"active"`. `start` itself never shows up as its own lane: fanning out is one
step, not two.

> [!NOTE] `laneId` is synthesized fresh on every call, from a lane's position in that call's own
> result array.
> It's stable within one snapshot, useful for telling two branches returned together apart, but not
> across two separate `stepOnce` calls: key off `node` instead if you're comparing lanes over time.

## Driving until blocked

Stepping one node at a time gets tedious once a flow has more than a couple of nodes worth skipping
past. `stepUntilBlocked` drives every lane forward until each one is `"parked"` or `"done"`, then
returns, the same `StepResult` shape as `stepOnce`.

```ts source=docs/examples/testing-your-flows/step-through.ts#until-blocked
export async function untilBlockedDemo() {
  const ready = await runtime({ models: () => fakePort, bindings: [], store: memoryStore() });
  return stepUntilBlocked(pipeline, ready);
}
```

Run against the same pipeline, this settles with both lanes parked: `fast` has folded its output in
and is waiting on its sibling to reach `merge` (parked, no `waitingFor`); `humanReply` is genuinely
blocked on external input (parked, `waitingFor: ["resume"]`).
You might expect `"parked"` to mean one thing, but it covers two different situations here: checking
`waitingFor` is what tells them apart, not the status string alone.

## Stepping until a condition

Sometimes neither extreme is quite right: not one node, not the whole flow, but "keep going until we
reach this specific point." `stepUntil(flow, runtime, condition)` steps one node at a time, like
`stepOnce`, until `condition` matches the current `StepResult`. `atNode(handle)` builds the most
common condition: satisfied the moment any lane sits at that node.

```ts source=docs/examples/testing-your-flows/step-through.ts#step-until
export async function stepUntilFastDemo() {
  const ready = await runtime({ models: () => fakePort, bindings: [], store: memoryStore() });
  return stepUntil(pipeline, ready, atNode(fastNode));
}

// `merge` only runs once both branches fold into it. `humanReply` never
// gets its "resume" message here, so the condition can never be satisfied:
// every lane ends up parked, and stepUntil throws StepUntilError("stalled")
// instead of stepping forever.
export async function stepUntilStalledDemo() {
  const ready = await runtime({ models: () => fakePort, bindings: [], store: memoryStore() });
  return stepUntil(pipeline, ready, atNode(mergeNode));
}

// A cycle that never parks and never satisfies its condition: stepUntil
// throws StepUntilError("budget-exceeded") once maxSteps is spent, rather
// than looping forever.
export const infiniteLoop: Graph = defineGraph("infinite-loop", (flow) => {
  const a = flow.step(
    outputs(() => "a"),
    { label: "a" },
  );
  const b = flow.step(
    outputs(() => "b"),
    { label: "b" },
  );
  flow.entry(a);
  a.then(b);
  b.then(a);
});

export async function stepUntilBudgetExceededDemo() {
  const ready = await runtime({ models: () => fakePort, bindings: [], store: memoryStore() });
  return stepUntil(infiniteLoop, ready, () => false, { maxSteps: 5 });
}
```

`stepUntilFastDemo` reaches `fast` and returns normally.
The other two demonstrate `StepUntil`'s two failure modes, both surfaced as `StepUntilError`,
distinguished by `.reason`:

- **`"stalled"`**: every lane is parked or done, and the condition still isn't satisfied.
  `stepUntilStalledDemo` waits for `merge`, but `humanReply` never gets its message here, so `merge`
  never runs.
  That state is deterministic: stepping again can't change it, so `stepUntil` fails loudly instead
  of hanging.
- **`"budget-exceeded"`**: `maxSteps` (default 1000) ran out while lanes were still active.
  `infiniteLoop` cycles between two steps forever, never parking and never satisfying `() => false`;
  capping `maxSteps` at 5 turns an infinite loop into a fast, failing test instead of a timeout.

> [!TIP] Reach for `"stalled"` as a real assertion, not just a possibility: a stuck flow is often
> the bug you're trying to catch, and `StepUntilError`'s message says exactly how many steps ran
> before it gave up.

## Recap

- `@behalf-js/testing` wraps the engine's internal `tick`/`tickUntilSuspended` in a test author's
  own vocabulary, kept out of `@behalf-js/core`'s main entry
- `stepOnce` advances every lane by one node; `stepUntilBlocked` drives until every lane is parked
  or done
- `stepUntil(flow, runtime, condition)` steps until `condition` matches; `atNode(handle)` builds the
  common "reached this node" condition
- `StepUntilError` distinguishes `"stalled"` (deterministically stuck) from `"budget-exceeded"`
  (`maxSteps` spent while still active)
- Next: exercise a flow without a real model, in [Setting up fakes](./setting-up-fakes.md)

---

**Reference:** reference.md § Testing (full block: stepOnce/stepUntilBlocked,
stepUntil/atNode/StepUntilError). **Examples:** `docs/examples/testing-your-flows/step-through.ts`,
regions: `step-once`, `until-blocked`, `step-until`. **Section:** [Testing](./README.md) **Prev /
Next:** [Model ports and bindings](../wiring-a-runtime/model-ports-and-bindings.md) /
[Setting up fakes](./setting-up-fakes.md)
