import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { storeOnlyRuntime, neverCalled, loggedEventTypes } from "./support.js";

describe.skip("fan-out and fan-in", () => {
  const fanOut = defineGraph("fan-out", (flow) => {
    const start = flow.step(outputs(() => "go"));
    const a = flow.step(outputs(() => "a"));
    const b = flow.step(outputs(() => "b"));
    const c = flow.step(outputs(() => "c"));
    const join = flow.step(outputs((context) => context.inputs));

    flow.entry(start);
    start.then([a, b, c]).join(join);
    join.then(flow.finish);
  });

  it("runs each branch once, joins with one input per branch", async () => {
    // given the graph above
    // when the flow runs
    const result = await runFlow(fanOut, userText("go"), await storeOnlyRuntime());

    // then the join step received one input per branch, in declaration order
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("appends one output event per branch, plus the start and join steps", async () => {
    // given the graph above, and a store we can inspect after the run
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs
    await runFlow(fanOut, userText("go"), ready);

    // then the log holds the initial message and five outputs (start, 3 branches, join)
    // (branch order among a/b/c may not be deterministic — count only, don't assert order)
    const types = loggedEventTypes(store);
    expect(types[0]).toBe("message");
    expect(types.filter((type) => type === "output")).toHaveLength(5);
  });
});
