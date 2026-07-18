import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { neverCalled, loggedEventTypes } from "./support.js";

describe.skip("invalidate reruns a node out of band", () => {
  // A fresh counter per test, so `planRuns` starts at zero each time.
  function planThenImplement() {
    let planRuns = 0;
    return defineGraph("plan-then-implement", (flow) => {
      const plan = flow.step(
        outputs(() => {
          planRuns += 1;
          return `draft-${String(planRuns)}`;
        }),
      );
      const implement = flow.step((context) => {
        const draft = context.inputs[0] as string;
        return Promise.resolve(
          draft === "draft-1"
            ? context.invalidate(plan.id, { reason: userText("revise the plan") })
            : context.output(`implemented:${draft}`),
        );
      });
      flow.entry(plan);
      plan.then(implement);
      implement.then(flow.finish);
    });
  }

  it("reruns the invalidated node, and its fresh output flows onward as normal", async () => {
    // given a plan step that produces a fresh draft each run, and an implement
    // step that invalidates the plan once, then accepts its second draft
    const graph = planThenImplement();
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    // when the flow runs
    const result = await runFlow(graph, userText("go"), ready);

    // then plan reran with the reason, and implement finished on the new draft
    expect(result).toBe("implemented:draft-2");
  });

  it("appends an invalidation event to the session log", async () => {
    // given the same graph, and a store we can inspect after the run
    const graph = planThenImplement();
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs
    await runFlow(graph, userText("go"), ready);

    // then the log records the invalidation between the two plan runs
    // (loose on exact position — confirm against reference.md's invalidate behaviour
    // when this slice is active)
    expect(loggedEventTypes(store)).toContain("invalidation");
  });
});
