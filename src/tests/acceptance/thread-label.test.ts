import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe("a step's thread label", () => {
  const labeled = defineGraph("labeled-step", (flow) => {
    const coder = flow.step(
      outputs((context) => context.thread.label),
      { label: "coder" },
    );
    flow.entry(coder);
    coder.then(flow.finish);
  });

  it("gives the step's thread a stable label, readable via context.thread.label", async () => {
    const result = await runFlow(labeled, userText("go"), await storeOnlyRuntime());

    expect(result).toBe("coder");
  });
});
