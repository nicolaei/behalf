import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe.skip("a cycle through a distinct intermediate node", () => {
  // A fresh counter per test — this graph isn't a self-loop like the agent
  // loop; it routes A -> B -> A, which a routing bug could get away with
  // faking as a plain self-loop.
  function cycleGraph() {
    let count = 0;
    return defineGraph("multi-node-cycle", (flow) => {
      const a = flow.step(
        outputs(() => {
          count += 1;
          return count;
        }),
      );
      const b = flow.step(outputs((context) => context.inputs[0]));
      flow.entry(a);
      a.when((value) => (value as number) >= 3, flow.finish).otherwise(b);
      b.then(a);
    });
  }

  it("loops A -> B -> A until the condition holds, then finishes with A's last output", async () => {
    const result = await runFlow(cycleGraph(), userText("go"), await storeOnlyRuntime());

    expect(result).toBe(3);
  });
});
