import { describe, it, expect } from "vitest";
import { stepUntilBlocked } from "../../testing/index.js";
import { defineGraph, runtime, adapters, join, outputs } from "../../index.js";
import { neverCalled, submitApproval } from "../acceptance/support.js";

describe("a fan-out where the parked branch is declared before the active one", () => {
  // start.then([wait, a]) — wait declared FIRST. Regression: naive
  // "first not-done branch" selection would keep re-picking the parked
  // wait branch forever, starving `a`, hanging stepUntilBlocked.
  const flow = defineGraph("fan-out-parked-first", (flowBuilder) => {
    const start = flowBuilder.step(outputs(() => "go"));
    const wait = flowBuilder.waitFor("approval");
    const a = flowBuilder.step(outputs(() => "a"));
    const joinStep = flowBuilder.step(join((context) => context.inputs));
    flowBuilder.entry(start);
    start.then([wait, a]);
    wait.then(joinStep);
    a.then(joinStep);
    joinStep.then(flowBuilder.finish);
  });

  it("advances the active branch instead of starving on the parked one", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const parked = await stepUntilBlocked(flow, ready);
    // `a` has already finished (structurally "parked" waiting on its
    // sibling, per the two meanings of "parked" this module documents:
    // waitingFor absent means "done, just waiting on siblings", not
    // "blocked on external input") — the fix's actual proof is that
    // stepUntilBlocked returned at all instead of hanging forever.
    expect(parked.some((lane) => lane.status === "parked" && lane.waitingFor)).toBe(true);
    expect(parked.some((lane) => lane.status === "parked" && !lane.waitingFor)).toBe(true);

    submitApproval(store);

    const resumed = await stepUntilBlocked(flow, ready);
    expect(resumed).toHaveLength(1);
    expect(resumed).toMatchObject([{ status: "done" }]);
  });
});
