import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, stateChanges } from "./support.js";

describe("stateChange on a `use` node's own state", () => {
  it("emits for the use node's own state before its subgraph runs", async () => {
    const subgraph = defineGraph("use-node-state-subgraph", (flow) => {
      // the subgraph's own node carries no state — proves the `stateChange`
      // below came from the `use` node itself, not something inside it
      const echo = flow.step(outputs(() => "echoed"));
      flow.entry(echo);
      echo.then(flow.finish);
    });

    const graph = defineGraph("use-node-state", (flow) => {
      const composed = flow.use(subgraph, { state: "red" });
      flow.entry(composed);
      composed.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    const result = await runFlow(graph, userText("go"), ready);

    expect(result).toBe("echoed");
    expect(stateChanges(store)).toEqual([{ to: "red" }]);
  });
});
