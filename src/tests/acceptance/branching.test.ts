import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { storeOnlyRuntime, neverCalled, loggedEventTypes } from "./support.js";

describe("branching on a step's output", () => {
  function branchOn(classifyValue: boolean) {
    return defineGraph(`branch-${String(classifyValue)}`, (flow) => {
      const classify = flow.step(outputs(() => classifyValue));
      const onTrue = flow.step(outputs(() => "yes"));
      const onFalse = flow.step(outputs(() => "no"));

      flow.entry(classify);
      classify.when((value) => value === true, onTrue).otherwise(onFalse);
      onTrue.then(flow.finish);
      onFalse.then(flow.finish);
    });
  }

  it("routes to the matching `when` edge, not the fallthrough", async () => {
    const result = await runFlow(branchOn(true), userText("hi"), await storeOnlyRuntime());

    expect(result).toBe("yes");
  });

  it("routes to `otherwise` when no `when` condition matches", async () => {
    // this is the case a routing implementation that just picks the first
    // declared edge would get wrong — the `when` condition here is false
    const result = await runFlow(branchOn(false), userText("hi"), await storeOnlyRuntime());

    expect(result).toBe("no");
  });

  it("appends one output event per step that ran, not the step that didn't", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(branchOn(true), userText("hi"), ready);

    // only `classify` and `onTrue` run — `onFalse` never fires
    expect(loggedEventTypes(store)).toEqual(["message", "output", "output"]);
  });
});
