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
    const result = await runFlow(echo, userText("hi"), await storeOnlyRuntime());

    expect(result).toBe("done");
  });

  it("appends the initial message, then the step's output", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(echo, userText("hi"), ready);

    expect(loggedEventTypes(store)).toEqual(["message", "output"]);
    expect(loggedEventAt(store, 1).event).toEqual({ value: "done" });
  });
});
