import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { storeOnlyRuntime, neverCalled, loggedEventTypes, loggedEventAt } from "./support.js";

describe("a graph with a single step", () => {
  const echo = defineGraph("echo", (flow) => {
    const respond = flow.step(outputs(() => "done"));
    flow.entry(respond);
    respond.then(flow.finish);
  });

  it("resolves with the step's output", async () => {
    // given the graph above, run through a runtime with no adapters
    // when the flow runs
    const result = await runFlow(echo, userText("hi"), await storeOnlyRuntime());

    // then the result is the step's output
    expect(result).toBe("done");
  });

  it("appends the expected events to the session log", async () => {
    // given the graph above, and a store we can inspect after the run
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs
    await runFlow(echo, userText("hi"), ready);

    // then the log holds the initial message, then the step's output
    expect(loggedEventTypes(store)).toEqual(["message", "output"]);
    expect(loggedEventAt(store, 1).event).toEqual({ value: "done" });
  });
});
