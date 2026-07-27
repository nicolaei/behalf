import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, userInput } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, loggedEnvelopes } from "./support.js";

describe("an interrupt node's own label is preserved on its output envelope", () => {
  it("stamps stepName with the interrupt's declared label, same as any other node kind", async () => {
    const graph = defineGraph("interrupt-label", (flow) => {
      const wait = flow.waitFor(userInput("resume"));
      const afterWait = flow.step(outputs(() => "resumed"));
      const cancelled = flow.interrupt(
        userInput("cancel"),
        outputs(() => "cancelled"),
        {
          label: "cancel-handler",
        },
      );
      flow.entry(wait);
      wait.then(afterWait);
      afterWait.then(flow.finish);
      cancelled.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(graph, userText("go"), ready);
    store.receive({
      kind: "message",
      message: { role: "user", intent: "standard", kind: "cancel", content: [] },
    });
    await done;

    // `findInterruptNodes` already reads `label` off the graph's interrupt node —
    // this pins down that it actually reaches the committed envelope, the same
    // way `stepIdentity(nodeId, node.label)` does for every other node kind.
    const outputEnvelope = loggedEnvelopes(store).find((envelope) => envelope.type === "output");
    expect(outputEnvelope?.stepName).toBe("cancel-handler");
  });
});
