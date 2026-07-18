import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { storeOnlyRuntime, neverCalled, textOf, loggedEventTypes } from "./support.js";

describe.skip("composing a graph as a node with `use`", () => {
  const inner = defineGraph("inner", (flow) => {
    const echo = flow.step(
      outputs((context) => textOf(context.thread.messages.at(-1)).toUpperCase()),
    );
    flow.entry(echo);
    echo.then(flow.finish);
  });

  const outer = defineGraph("outer", (flow) => {
    const start = flow.step(outputs(() => "hi"));
    const sub = flow.use(inner);
    flow.entry(start);
    start.then(sub, { prompt: (value) => userText(String(value)) });
    sub.then(flow.finish);
  });

  it("seeds the subgraph with the incoming value; its result is the use node's output", async () => {
    // given the outer graph above, composing `inner` as a node
    // when the flow runs
    const result = await runFlow(outer, userText("go"), await storeOnlyRuntime());

    // then the subgraph's finish value is what the outer graph resolves with
    expect(result).toBe("HI");
  });

  it("appends the subgraph's messages and output to the same session log", async () => {
    // given the same graphs, and a store we can inspect after the run
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs
    await runFlow(outer, userText("go"), ready);

    // then the log holds both the outer and the subgraph's events
    // (loose on exact shape — confirm against reference.md's `use`/prompt behaviour
    // when this slice is active)
    const types = loggedEventTypes(store);
    expect(types.filter((type) => type === "message").length).toBeGreaterThanOrEqual(2);
    expect(types.filter((type) => type === "output").length).toBeGreaterThanOrEqual(2);
  });
});
