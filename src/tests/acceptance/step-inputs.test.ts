import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe.skip("a step reading its predecessor's output via context.inputs", () => {
  const pipeline = defineGraph("pipeline", (flow) => {
    const first = flow.step(outputs(() => ({ value: 42 })));
    const second = flow.step(outputs((context) => context.inputs[0]));
    flow.entry(first);
    first.then(second);
    second.then(flow.finish);
  });

  it("receives the exact upstream output value, not a thread message", async () => {
    const result = await runFlow(pipeline, userText("go"), await storeOnlyRuntime());

    expect(result).toEqual({ value: 42 });
  });
});
