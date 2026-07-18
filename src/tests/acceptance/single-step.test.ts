import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe("a graph with a single step", () => {
  it("resolves with the step's output", async () => {
    // given a graph whose only step outputs a fixed value, straight to finish
    const echo = defineGraph("echo", (flow) => {
      const respond = flow.step((context) => Promise.resolve(context.output("done")));
      flow.entry(respond);
      respond.then(flow.finish);
    });

    // when the flow runs
    const result = await runFlow(echo, userText("hi"), await storeOnlyRuntime());

    // then the result is the step's output
    expect(result).toBe("done");
  });
});
