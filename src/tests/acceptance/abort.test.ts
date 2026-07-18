import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import type { ModelPort, Profile } from "../../index.js";

describe.skip("abort", () => {
  // Deliberately one `it`, not a graph/log pair: the aborted flag on the log
  // IS the behaviour under test here, not a secondary observation of it.
  it("cancels the in-flight step and commits what streamed, marked aborted", async () => {
    // given a model call that streams partial content, then never resolves on its own
    const slowPort: ModelPort = {
      model: { identifier: "slow", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: (_profile, _messages, stream) =>
        new Promise(() => {
          stream.delta({ correlationId: "1", open: "text" });
          stream.delta({ correlationId: "1", text: "partial" });
          // never resolves — only an abort should end this step
        }),
    };
    const profile: Profile = { model: slowPort.model, system: "test", tools: [] };
    const graph = defineGraph("aborts", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flow.entry(respond);
      respond.then(flow.finish);
    });
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: () => slowPort, bindings: [], store });

    // when the flow runs, and an abort is submitted before the model call resolves
    // (best-effort design — confirm the exact abort/streaming contract against
    // reference.md's Gateway behaviour when this slice is active)
    const done = runFlow(graph, userText("hi"), ready).catch(() => undefined);
    store.submit({ role: "user", intent: "abort", content: [] });
    await done;

    // then some committed envelope is marked aborted
    const aborted = store
      .events()
      .some((envelope) => envelope.form === "committed" && envelope.aborted === true);
    expect(aborted).toBe(true);
  });
});
