import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, join } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, stateChanges } from "./support.js";

describe("stateChange inside a static fan-out (.then([a, b]))", () => {
  // Two branches declare the SAME state — since each branch already forks
  // onto its own thread, they must be tracked independently: neither
  // suppresses nor sees the other's transition.
  const graph = defineGraph("fan-out-state", (flow) => {
    const start = flow.step(outputs(() => "go"));
    const a = flow.step(
      outputs(() => "a"),
      { state: "processing" },
    );
    const b = flow.step(
      outputs(() => "b"),
      { state: "processing" },
    );
    const joinStep = flow.step(join((context) => context.inputs));

    flow.entry(start);
    start.then([a, b]);
    a.then(joinStep);
    b.then(joinStep);
    joinStep.then(flow.finish);
  });

  it("emits one stateChange per branch, independently, not deduplicated across branches", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(graph, userText("go"), ready);

    // each branch is its own thread, so both fire — collapsing them into one
    // would silently drop one branch's transition
    expect(stateChanges(store)).toEqual([{ to: "processing" }, { to: "processing" }]);
  });
});
