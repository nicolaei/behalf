import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { neverCalled, loggedEventTypes } from "./support.js";

describe.skip("interrupt fires wherever the graph currently is", () => {
  function withInterrupt() {
    return defineGraph("with-interrupt", (flow) => {
      const wait = flow.waitFor("resume");
      const afterWait = flow.step(outputs(() => "resumed"));
      const cancelled = flow.interrupt(
        "cancel",
        outputs(() => "cancelled"),
      );

      flow.entry(wait);
      wait.then(afterWait);
      afterWait.then(flow.finish);
      cancelled.then(flow.finish);
    });
  }

  it("bypasses the normal path when its kind arrives instead", async () => {
    // given a graph parked at `waitFor("resume")`, with an always-armed
    // interrupt for a different kind
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs, parked at `waitFor`, and a "cancel" message arrives instead of "resume"
    // NOTE: submit timing is the same known open concern as waitFor's own test.
    const done = runFlow(withInterrupt(), userText("go"), ready);
    store.submit({ role: "user", intent: "standard", kind: "cancel", content: [] });

    // then the interrupt fired, not the waited-for path
    expect(await done).toBe("cancelled");
  });

  it("appends the interrupt's output to the session log", async () => {
    // given the same graph, and a store we can inspect after the run
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs and "cancel" arrives
    const done = runFlow(withInterrupt(), userText("go"), ready);
    store.submit({ role: "user", intent: "standard", kind: "cancel", content: [] });
    await done;

    // then the log holds the interrupt's output
    // (loose on exact shape — confirm against reference.md's interrupt behaviour
    // when this slice is active)
    expect(loggedEventTypes(store)).toContain("output");
  });
});
