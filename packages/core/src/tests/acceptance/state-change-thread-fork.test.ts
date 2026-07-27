import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, stateChanges } from "./support.js";

describe("stateChange and the general fork rule: a new thread id always starts with a clean slate", () => {
  // A plain edge fork, no invalidate/fan-out/forEach involved — proves the
  // rule directly, so every other test that also forks a thread (invalidate,
  // fan-out, forEach) is just this same rule applying to their own case.
  const graph = defineGraph("edge-fork-state", (flow) => {
    const start = flow.step(
      outputs(() => "go"),
      { state: "red" },
    );
    const forked = flow.step(
      outputs(() => "done"),
      { state: "red" },
    );
    flow.entry(start);
    start.then(forked, { threadAction: "fork" });
    forked.then(flow.finish);
  });

  it("fires again with no `from` on the forked thread, even for the same state value", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(graph, userText("go"), ready);

    // "red" on the start thread, then "red" again on the forked thread —
    // two independent first-entries, not one collapsed transition
    expect(stateChanges(store)).toEqual([{ to: "red" }, { to: "red" }]);
  });
});
