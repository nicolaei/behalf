import { describe, it, expect } from "vitest";
import { tick } from "../../engine/runtime.js";
import type { TickOutcome } from "../../engine/runtime.js";
import { defineGraph, runtime, adapters, join, outputs } from "../../index.js";
import { neverCalled } from "../acceptance/support.js";

// Needs tick() to support fan-out — currently it throws
// notImplemented("tick: fan-out") whenever a step's outcome carries
// pendingInputs. This is the prerequisite for driving a fan-out flow one
// node at a time instead of only via runFlow's Promise.all-based runBranch.
describe("ticking a fan-out flow", () => {
  const fanOut = defineGraph("tick-fan-out", (flow) => {
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

  it("reports fan-out branches as independent cursors, then folds to one root result", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const seen: TickOutcome[] = [];
    let outcome = await tick(fanOut, ready);
    seen.push(outcome);

    // drive until every cursor is done, bounded so a real bug fails fast
    // with a clear assertion rather than hanging until vitest's own timeout
    const maxIterations = 20;
    for (let i = 0; i < maxIterations && outcome.some((cursor) => cursor.status !== "done"); i++) {
      outcome = await tick(fanOut, ready);
      seen.push(outcome);
    }

    // at some point both branches were visible as independent, live cursors —
    // not collapsed into one status the way the old 3-way discriminant was
    expect(seen.some((snapshot) => snapshot.length > 1)).toBe(true);

    expect(outcome).toHaveLength(1);
    expect(outcome).toMatchObject([{ status: "done" }]);
    expect((outcome[0] as { result: unknown }).result).toEqual(expect.arrayContaining(["a", "b"]));
  });
});
