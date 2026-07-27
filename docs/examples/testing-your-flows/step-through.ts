// The Learn "Testing your flows" page's example: a fan-out worth stepping
// through one node at a time, not a plain linear flow. `fast` finishes on
// its own; `humanReply` parks until a "resume" message arrives; both fold
// at `merge` before `finish`. Driven with `fakePort` in step-through.test.ts,
// so every claim this page makes about `stepOnce`/`stepUntilBlocked`/
// `stepUntil` is checked by a real assertion, not just shown in prose.

import {
  defineGraph,
  outputs,
  join,
  userInput,
  runtime,
  type Graph,
  type Handle,
} from "@behalf-js/core";
import { fakePort } from "@behalf-js/testing";
import { memoryStore } from "@behalf-js/stores";
import { stepOnce, stepUntilBlocked, stepUntil, atNode } from "@behalf-js/testing";

// #region step-once
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
// #endregion step-once

// #region until-blocked
export async function untilBlockedDemo() {
  const ready = await runtime({ models: () => fakePort, bindings: [], store: memoryStore() });
  return stepUntilBlocked(pipeline, ready);
}
// #endregion until-blocked

// #region step-until
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
// #endregion step-until
