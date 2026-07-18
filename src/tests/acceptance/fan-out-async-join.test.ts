import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe.skip("fan-in waits for the slower branch", () => {
  const fanOutAsync = defineGraph("fan-out-async", (flow) => {
    const start = flow.step(outputs(() => "go"));
    const fast = flow.step(outputs(() => "fast"));
    const slow = flow.step(async (context) => {
      // a few microtask hops stand in for "slower than the other branch",
      // without reaching for a timer global
      await Promise.resolve();
      await Promise.resolve();
      return context.output("slow");
    });
    const join = flow.step(outputs((context) => context.inputs));
    flow.entry(start);
    start.then([fast, slow]).join(join);
    join.then(flow.finish);
  });

  it("runs the join exactly once, once the slower branch also finishes", async () => {
    const result = await runFlow(fanOutAsync, userText("go"), await storeOnlyRuntime());

    expect(result).toEqual(expect.arrayContaining(["fast", "slow"]));
    expect(result).toHaveLength(2);
  });
});
