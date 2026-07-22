import { describe, it, expect } from "vitest";
import { defineGraph, runtime, adapters, outputs } from "../../../index.js";
import { neverCalled } from "../../acceptance/support.js";
import { stepUntil, atNode } from "../../../testing/graph/index.js";

describe("stepUntil stops at a node and folds partial state into a Run", () => {
  let a!: ReturnType<Parameters<Parameters<typeof defineGraph>[1]>[0]["step"]>;
  let b!: ReturnType<Parameters<Parameters<typeof defineGraph>[1]>[0]["step"]>;

  const twoStep = defineGraph("two-step", (flow) => {
    a = flow.step(outputs(() => "a"));
    b = flow.step(outputs((context) => `${String(context.inputs[0])}-b`));
    flow.entry(a);
    a.then(b);
    b.then(flow.finish);
  });

  it("stops at the target node, then continuing resumes from there (not from entry)", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const atA = await stepUntil(twoStep, ready, atNode(a));
    expect(atA.traversal.map((e) => e.node)).toEqual([a.id]);

    const atB = await stepUntil(twoStep, ready, atNode(b));
    // must show exactly one more entry (b), not [a, a, b] — proves it continued, not replayed from scratch
    expect(atB.traversal.map((e) => e.node)).toEqual([a.id, b.id]);
  });
});
