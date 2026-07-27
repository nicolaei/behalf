import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, stateChanges } from "./support.js";

describe("stateChange and invalidate: same thread suppresses, a forked/new thread starts fresh", () => {
  it("does not refire when the invalidated node reruns on the same thread", async () => {
    let planRuns = 0;
    const graph = defineGraph("invalidate-same-thread", (flow) => {
      const plan = flow.step(
        outputs(() => (planRuns += 1)),
        { state: "red" },
      );
      const implement = flow.step((context) =>
        Promise.resolve(
          context.inputs[0] === 1
            ? context.invalidate(plan.id, { reason: userText("revise") })
            : context.output("done"),
        ),
      );
      flow.entry(plan);
      plan.then(implement);
      implement.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    const result = await runFlow(graph, userText("go"), ready);

    expect(planRuns).toBe(2);
    expect(result).toBe("done");
    // one stateChange, even though `plan` ran twice on the same thread
    expect(stateChanges(store)).toEqual([{ to: "red" }]);
  });

  it("fires again with no `from` when the invalidated node reruns on a forked thread", async () => {
    let planRuns = 0;
    const graph = defineGraph("invalidate-fork", (flow) => {
      const plan = flow.step(
        outputs(() => (planRuns += 1)),
        { state: "red" },
      );
      const implement = flow.step((context) =>
        Promise.resolve(
          context.inputs[0] === 1
            ? context.invalidate(plan.id, { threadAction: "fork" })
            : context.output("done"),
        ),
      );
      flow.entry(plan);
      plan.then(implement);
      implement.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(graph, userText("go"), ready);

    // a forked thread is a fresh context: its own first "red" fires clean,
    // with no `from`, exactly like a brand-new thread's own first state
    expect(stateChanges(store)).toEqual([{ to: "red" }, { to: "red" }]);
  });
});
