import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, stateChanges } from "./support.js";

describe("stateChange inside forEach branches", () => {
  // Unlike a static fan-out branch, a forEach branch runs on the PARENT's own
  // thread, not a forked one (see foreach-branch-finish-thread.test.ts, which
  // pins that down independently). So two branches declaring the same state
  // are really two nodes on the same thread — the same dedup rule that
  // collapses a retried or invalidated node's repeat entry applies here too:
  // one stateChange, not one per branch.
  const graph = defineGraph("foreach-state", (flow) => {
    const produce = flow.step(outputs(() => ["a", "b"]));
    const each = flow.forEach(
      (output) => output as string[],
      (item) =>
        defineGraph(`foreach-branch-${item}`, (branchFlow) => {
          const work = branchFlow.step(
            outputs(() => item),
            { state: "processing" },
          );
          branchFlow.entry(work);
          work.then(branchFlow.finish);
        }),
    );
    flow.entry(produce);
    produce.then(each);
    each.then(flow.finish);
  });

  it("dedupes stateChange across branches that share the parent's thread", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(graph, userText("go"), ready);

    expect(stateChanges(store)).toEqual([{ to: "processing" }]);
  });
});
