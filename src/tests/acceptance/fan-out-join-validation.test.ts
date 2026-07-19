import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs, join } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe("fan-out join() validation", () => {
  it("rejects when the convergence node is not tagged with join()", async () => {
    // A classic three-branch fan-out whose convergence node is built with
    // outputs() instead of join() — the engine must throw rather than silently
    // running it with a multi-element inputs array.
    const badGraph = defineGraph("bad-join", (flow) => {
      const start = flow.step(outputs(() => "go"));
      const a = flow.step(outputs(() => "a"));
      const b = flow.step(outputs(() => "b"));
      // Deliberately use outputs() instead of join() at the convergence point.
      const converge = flow.step(outputs((context) => context.inputs));

      flow.entry(start);
      start.then([a, b]);
      a.then(converge);
      b.then(converge);
      converge.then(flow.finish);
    });

    await expect(runFlow(badGraph, userText("go"), await storeOnlyRuntime())).rejects.toThrow(
      "was not defined with join()",
    );
  });

  it("rejects when a join()-tagged step is reached as a plain, single-input step", async () => {
    // A join()-tagged step used in an ordinary linear chain — no fan-out, one
    // inbound edge — must be rejected: join() declares the node expects every
    // branch's output as an array, but a plain step only ever gets one input.
    const badGraph = defineGraph("bad-plain-join", (flow) => {
      const start = flow.step(outputs(() => "go"));
      const converge = flow.step(join((context) => context.inputs));

      flow.entry(start);
      start.then(converge);
      converge.then(flow.finish);
    });

    await expect(runFlow(badGraph, userText("go"), await storeOnlyRuntime())).rejects.toThrow(
      "is tagged with join() but was reached as a plain step",
    );
  });
});
