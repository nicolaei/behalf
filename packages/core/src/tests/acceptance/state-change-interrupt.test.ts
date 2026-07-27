import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, userInput } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, stateChanges } from "./support.js";

describe("stateChange on an interrupt node's own state", () => {
  it("emits when an armed interrupt wins the race and takes over routing", async () => {
    const graph = defineGraph("interrupt-state", (flow) => {
      const wait = flow.waitFor(userInput("resume"), { state: "red" });
      const afterWait = flow.step(outputs(() => "resumed"));
      const cancelled = flow.interrupt(
        userInput("cancel"),
        outputs(() => "cancelled"),
        {
          state: "yellow",
        },
      );

      flow.entry(wait);
      wait.then(afterWait);
      afterWait.then(flow.finish);
      cancelled.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(graph, userText("go"), ready);
    store.receive({
      kind: "message",
      message: { role: "user", intent: "standard", kind: "cancel", content: [] },
    });

    expect(await done).toBe("cancelled");
    expect(stateChanges(store)).toEqual([{ to: "red" }, { from: "red", to: "yellow" }]);
  });
});
