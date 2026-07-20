import { describe, it, expect } from "vitest";
import { tickUntilSuspended } from "../../engine/runtime.js";
import { defineGraph, runtime, adapters, join, outputs, userInput } from "../../index.js";
import { neverCalled, submitApproval } from "../acceptance/support.js";

// Regression test for advanceFanOutGroup's branch-selection bug: it used to
// pick the first not-done branch full stop (`Array.find`), so a branch
// parked at its own waitFor — still "not done" — would keep getting
// re-picked ahead of a live sibling declared after it, starving that
// sibling forever and making tickUntilSuspended loop indefinitely.
// tick-fan-out-branch-waits.test.ts only exercises the safe declaration
// order (`start.then([a, wait])`, live branch first), which is why this
// went uncaught. This flow uses the unsafe order (`start.then([wait, a])`,
// parked branch declared first) to prove the fix generalizes: the live
// sibling `a` must still advance to completion instead of the parked
// `wait` branch being retried forever.
// Permanent (not temporary): the ordering hazard is a real, subtle
// invariant of advanceFanOutGroup worth guarding against regressing.
describe("ticking a fan-out group whose parked branch is declared before its live sibling", () => {
  const flow = defineGraph("tick-fan-out-branch-order", (flowBuilder) => {
    const start = flowBuilder.step(outputs(() => "go"));
    const wait = flowBuilder.waitFor(userInput("approval"));
    const a = flowBuilder.step(outputs(() => "a"));
    const joinStep = flowBuilder.step(join((context) => context.inputs));
    flowBuilder.entry(start);
    start.then([wait, a]);
    wait.then(joinStep);
    a.then(joinStep);
    joinStep.then(flowBuilder.finish);
  });

  it("advances the live sibling instead of retrying the parked branch forever", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // If advanceFanOutGroup starves `a`, this call never returns (every
    // cursor stays "active" forever) and the test times out instead of
    // hanging silently.
    const parked = await tickUntilSuspended(flow, ready);

    // `wait` is parked on its own waitFor.
    expect(
      parked.some(
        (cursor) => cursor.status === "parked" && cursor.waitingFor?.includes("approval"),
      ),
    ).toBe(true);

    // `a` reached the join edge and is parked as done (no waitingFor) —
    // proof it was actually advanced, not starved by the parked `wait`.
    expect(
      parked.some((cursor) => cursor.status === "parked" && cursor.waitingFor === undefined),
    ).toBe(true);

    submitApproval(store);

    const resumed = await tickUntilSuspended(flow, ready);

    expect(resumed).toHaveLength(1);
    expect(resumed).toMatchObject([{ status: "done" }]);
  });
});
