import { describe, it, expect } from "vitest";
import { defineGraph, userText, outputs } from "../../index.js";
import { fakePortRuntime } from "./support.js";
import { runToCompletion } from "@behalf-js/testing";

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
    const result = await runToCompletion(labeled, userText("go"), await fakePortRuntime());

    expect(result).toBe("coder");
  });
});
