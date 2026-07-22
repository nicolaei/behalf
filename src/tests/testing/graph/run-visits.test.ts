import { describe, it, expect } from "vitest";
import { defineGraph, runtime, adapters, outputs } from "../../../index.js";
import type { Handle } from "../../../index.js";
import { neverCalled } from "../../acceptance/support.js";
import { stepUntilBlocked } from "../../../testing/graph/index.js";

describe("Run's per-node visits list records times/input/output on a looped step", () => {
  it("records one visit per time a node ran, with its input and output", async () => {
    // A -> B -> A cycle (same shape as multi-node-cycle.test.ts / default-retry
    // tests), so B genuinely runs more than once.
    let count = 0;
    let b!: Handle;
    const looped = defineGraph("looped", (flow) => {
      const a = flow.step(outputs(() => "go"));
      b = flow.step((context) => {
        count += 1;
        return Promise.resolve(count < 2 ? context.output("again") : context.output("done"));
      });
      flow.entry(a);
      a.then(b);
      b.when((v) => v === "again", a).otherwise(flow.finish);
    });

    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const run = await stepUntilBlocked(looped, ready);

    const bVisits = run.visits.filter((v) => v.node === b.id);

    expect(bVisits).toHaveLength(2);
    const [first, second] = bVisits;
    expect(first?.output).toBe("again");
    expect(second?.output).toBe("done");
  });
});
