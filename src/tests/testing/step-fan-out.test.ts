import { describe, it, expect } from "vitest";
import { stepOnce, stepUntilBlocked } from "../../testing/index.js";
import { defineGraph, runtime, adapters, join, outputs } from "../../index.js";
import { neverCalled } from "../acceptance/support.js";

// Story 4's own tests never exercised a fan-out flow (only linear graphs) —
// this proves stepOnce/stepUntilBlocked, not just tick() directly, correctly
// surface multiple concurrent lanes and fold them to one root result.
describe("the testing module driving a fan-out flow", () => {
  const fanOut = defineGraph("step-fan-out", (flow) => {
    const start = flow.step(outputs(() => "go"));
    const a = flow.step(outputs(() => "a"));
    const b = flow.step(outputs(() => "b"));
    const joinStep = flow.step(join((context) => context.inputs));
    flow.entry(start);
    start.then([a, b]);
    a.then(joinStep);
    b.then(joinStep);
    joinStep.then(flow.finish);
  });

  it("stepOnce shows multiple concurrent lanes mid-fan-out", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    await stepOnce(fanOut, ready); // runs `start`
    const afterFanOut = await stepOnce(fanOut, ready); // spawns branch lanes

    expect(afterFanOut.length).toBeGreaterThan(1);
  });

  it("stepUntilBlocked drives a fan-out flow to a single done result", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const result = await stepUntilBlocked(fanOut, ready);

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([{ status: "done", result: ["a", "b"] }]);
  });
});
