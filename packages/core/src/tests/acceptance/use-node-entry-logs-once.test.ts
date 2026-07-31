import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, loggedEnvelopes } from "./support.js";

// seedUseNode unconditionally re-commits a real Message input to the log.
// When a `use` node is the graph's own entry, its input was already
// committed — as the top-level `input` event runFlow's own `seed()` call
// appends — by whoever called driveGraph (runFlow, here) one line earlier —
// double-logging the same message on the same thread.
describe("a use node as the graph's own entry", () => {
  it("logs the initial input once, not twice", async () => {
    const inner = defineGraph("inner", (flow) => {
      const step = flow.step((context) => Promise.resolve(context.output("done")));
      flow.entry(step);
      step.then(flow.finish);
    });
    const outer = defineGraph("outer-use-entry", (flow) => {
      const use = flow.use(inner);
      flow.entry(use);
      use.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(outer, userText("hi"), ready);

    const inputEvents = loggedEnvelopes(store).filter((e) => e.type === "input");
    expect(inputEvents).toHaveLength(1);
  });
});
