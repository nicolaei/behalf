import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, join, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe("a used subgraph that itself fans out", () => {
  const inner = defineGraph("use-fan-out-inner", (flow) => {
    const entry = flow.step(outputs(() => "go"));
    const a = flow.step(outputs(() => "a"));
    const b = flow.step(outputs(() => "b"));
    const joinStep = flow.step(join((context) => context.inputs));
    flow.entry(entry);
    entry.then([a, b]);
    a.then(joinStep);
    b.then(joinStep);
    joinStep.then(flow.finish);
  });

  const outer = defineGraph("use-fan-out-outer", (flow) => {
    const start = flow.step(outputs(() => "start"));
    const sub = flow.use(inner);
    flow.entry(start);
    start.then(sub);
    sub.then(flow.finish);
  });

  it("runs the subgraph's own fan-out and returns its joined result as the use node's output", async () => {
    const result = await runFlow(outer, userText("go"), await storeOnlyRuntime());

    expect(result).toEqual(expect.arrayContaining(["a", "b"]));
    expect(result).toHaveLength(2);
  });
});
