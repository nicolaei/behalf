import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import { storeOnlyRuntime, neverCalled, loggedEventTypes } from "./support.js";

describe.skip("branching on a step's output", () => {
  const branch = defineGraph("branch", (flow) => {
    const classify = flow.step((context) => Promise.resolve(context.output(true)));
    const onTrue = flow.step((context) => Promise.resolve(context.output("yes")));
    const onFalse = flow.step((context) => Promise.resolve(context.output("no")));

    flow.entry(classify);
    classify.when((value) => value === true, onTrue).otherwise(onFalse);
    onTrue.then(flow.finish);
    onFalse.then(flow.finish);
  });

  it("routes to the matching edge, not the fallthrough", async () => {
    // given the graph above
    // when the flow runs
    const result = await runFlow(branch, userText("hi"), await storeOnlyRuntime());

    // then it took the `when` branch
    expect(result).toBe("yes");
  });

  it("appends the expected events to the session log", async () => {
    // given the graph above, and a store we can inspect after the run
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs
    await runFlow(branch, userText("hi"), ready);

    // then the log holds the initial message, then one output per step that ran
    // (only `classify` and `onTrue` run — `onFalse` never fires)
    expect(loggedEventTypes(store)).toEqual(["message", "output", "output"]);
  });
});
