import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, join } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { storeOnlyRuntime, neverCalled, loggedEventTypes } from "./support.js";

describe("fan-out and fan-in", () => {
  const fanOut = defineGraph("fan-out", (flow) => {
    const start = flow.step(outputs(() => "go"));
    const a = flow.step(outputs(() => "a"));
    const b = flow.step(outputs(() => "b"));
    const c = flow.step(outputs(() => "c"));
    const joinStep = flow.step(join((context) => context.inputs));

    flow.entry(start);
    start.then([a, b, c]);
    a.then(joinStep);
    b.then(joinStep);
    c.then(joinStep);
    joinStep.then(flow.finish);
  });

  it("runs each branch once, joins with one input per branch", async () => {
    const result = await runFlow(fanOut, userText("go"), await storeOnlyRuntime());

    // branches run in parallel on their own forked threads, so the spec gives
    // no ordering guarantee across them — assert membership, not order
    expect(result).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(result).toHaveLength(3);
  });

  it("appends one output event per branch, plus the start and join steps", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(fanOut, userText("go"), ready);

    // then the log holds the initial message and five outputs (start, 3 branches, join)
    const types = loggedEventTypes(store);
    expect(types[0]).toBe("message");
    expect(types.filter((type) => type === "output")).toHaveLength(5);
  });
});
