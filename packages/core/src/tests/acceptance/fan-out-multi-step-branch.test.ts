import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, join, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe("fan-out with a multi-step branch", () => {
  const flowDef = defineGraph("multi-step-branch", (flow) => {
    const start = flow.step(outputs(() => "go"));
    const a1 = flow.step(outputs(() => "a1"));
    const a2 = flow.step(outputs((context) => `${String(context.inputs[0])}-a2`));
    const b = flow.step(outputs(() => "b"));
    const joinStep = flow.step(join((context) => context.inputs));

    flow.entry(start);
    start.then([a1, b]);
    a1.then(a2);
    a2.then(joinStep);
    b.then(joinStep);
    joinStep.then(flow.finish);
  });

  it("lets one branch run more than one step before joining", async () => {
    const result = await runFlow(flowDef, userText("go"), await storeOnlyRuntime());

    expect(result).toEqual(expect.arrayContaining(["a1-a2", "b"]));
    expect(result).toHaveLength(2);
  });
});
