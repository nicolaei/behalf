import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, stateChanges } from "./support.js";

describe("stateChange and a step retry: a retried node re-enters, but its state was already seen", () => {
  it("fires exactly once for a state-tagged step that errors once then recovers", async () => {
    let attempts = 0;
    const graph = defineGraph("retry-state", (flow) => {
      const step = flow.step(
        (context) => {
          attempts += 1;
          return Promise.resolve(
            attempts === 1
              ? context.fail({ type: "timeout", message: "boom", retryable: true })
              : context.output("recovered"),
          );
        },
        { state: "red" },
      );
      flow.entry(step);
      step.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    const result = await runFlow(graph, userText("go"), ready);

    expect(attempts).toBe(2);
    expect(result).toBe("recovered");
    expect(stateChanges(store)).toEqual([{ to: "red" }]);
  });
});
