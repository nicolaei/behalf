import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, join, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe("a fan-out branch that itself fans out", () => {
  const flowDef = defineGraph("nested-fan-out", (flow) => {
    const start = flow.step(outputs(() => "go"));
    const a = flow.step(outputs(() => "a"));
    const aa = flow.step(outputs(() => "aa"));
    const ab = flow.step(outputs(() => "ab"));
    const innerJoin = flow.step(join((context) => context.inputs));
    const b = flow.step(outputs(() => "b"));
    const outerJoin = flow.step(join((context) => context.inputs));

    flow.entry(start);
    start.then([a, b]);
    a.then([aa, ab]); // nested fan-out inside branch a — out of scope until Story 3
    aa.then(innerJoin);
    ab.then(innerJoin);
    innerJoin.then(outerJoin);
    b.then(outerJoin);
    outerJoin.then(flow.finish);
  });

  it("throws notImplemented rather than silently mishandling it", async () => {
    await expect(runFlow(flowDef, userText("go"), await storeOnlyRuntime())).rejects.toThrow(
      /fan-out branch that itself fans out/,
    );
  });
});
