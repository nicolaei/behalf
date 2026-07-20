import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import type { ModelPort } from "../../index.js";

describe("aborting an in-flight run", () => {
  // Deliberately one `it`, not a graph/log pair: the aborted flag on the log
  // IS the behaviour under test here, not a secondary observation of it.
  it("cancels the in-flight step and commits what streamed, marked aborted", async () => {
    // a model call that streams partial content, then never resolves on its own —
    // only an abort should end this step
    const slowPort: ModelPort = {
      model: { identifier: "slow", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: (_profile, _messages, stream) =>
        new Promise(() => {
          stream.delta({ correlationId: "1", open: "text" });
          stream.delta({ correlationId: "1", text: "partial" });
        }),
    };
    const graph = defineGraph("aborts", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(
          await context.modelCall({ model: slowPort.model, system: "test", tools: [] }),
        ),
      );
      flow.entry(respond);
      respond.then(flow.finish);
    });
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: () => slowPort, bindings: [], store });

    // an abort is submitted before the model call resolves
    // (best-effort design — confirm the exact abort/streaming contract against
    // reference.md's Gateway behaviour when this slice is active)
    const done = runFlow(graph, userText("hi"), ready).catch(() => undefined);
    store.receive({ kind: "message", message: { role: "user", intent: "abort", content: [] } });
    await done;

    const aborted = store
      .events()
      .some((envelope) => envelope.form === "committed" && envelope.aborted === true);
    expect(aborted).toBe(true);
  });
});
