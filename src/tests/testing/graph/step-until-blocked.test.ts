import { describe, it, expect } from "vitest";
import { defineGraph, runtime, adapters, outputs } from "../../../index.js";
import { neverCalled } from "../../acceptance/support.js";
import { stepUntilBlocked } from "../../../testing/graph/index.js";

describe("a graph with a single step", () => {
  const echo = defineGraph("echo", (flow) => {
    const step = flow.step(outputs(() => "done"));
    flow.entry(step);
    step.then(flow.finish);
  });

  it("folds the step's output into Run.output", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const run = await stepUntilBlocked(echo, ready);

    expect(run.output).toBe("done");
  });
});
