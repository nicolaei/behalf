import { describe, it, expect } from "vitest";
import { tickUntilSuspended } from "../../engine/runtime.js";
import { defineGraph, runtime, adapters, join, outputs, userInput } from "../../index.js";
import { neverCalled, submitApproval } from "../acceptance/support.js";

// Needs a fan-out branch to support a waitFor node — today runBranchNode
// throws notImplemented("fan-out branch node kind \"waitFor\"") for any
// non-step node inside a branch. This is the tick()-specific half of that
// capability: the branch must report parked with waitingFor, resumable
// across separate tick() calls, not just work via runFlow's blocking path
// (see fan-out-branch-waits.test.ts for the runFlow side).
describe("ticking a fan-out branch that waits for a message", () => {
  const flow = defineGraph("tick-fan-out-branch-waits", (flowBuilder) => {
    const start = flowBuilder.step(outputs(() => "go"));
    const a = flowBuilder.step(outputs(() => "a"));
    const wait = flowBuilder.waitFor(userInput("approval"));
    const joinStep = flowBuilder.step(join((context) => context.inputs));
    flowBuilder.entry(start);
    start.then([a, wait]);
    a.then(joinStep);
    wait.then(joinStep);
    joinStep.then(flowBuilder.finish);
  });

  it("reports the waiting branch as parked with waitingFor, resumable across tick calls", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const parked = await tickUntilSuspended(flow, ready);

    expect(
      parked.some(
        (cursor) => cursor.status === "parked" && cursor.waitingFor?.includes("approval"),
      ),
    ).toBe(true);

    submitApproval(store);

    const resumed = await tickUntilSuspended(flow, ready);

    expect(resumed).toHaveLength(1);
    expect(resumed).toMatchObject([{ status: "done" }]);
  });
});
