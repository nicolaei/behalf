import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { neverCalled, loggedEnvelopes } from "./support.js";

describe.skip("envelope metadata: sequence, at, stepId, stepName, threadId", () => {
  const labeled = defineGraph("labeled", (flow) => {
    const coder = flow.step(
      outputs(() => "done"),
      { label: "coder" },
    );
    flow.entry(coder);
    coder.then(flow.finish);
  });

  it("stamps a strictly increasing, gap-free sequence starting at 1", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(labeled, userText("go"), ready);

    const sequences = loggedEnvelopes(store).map((envelope) => envelope.sequence);
    expect(sequences[0]).toBe(1);
    for (let i = 1; i < sequences.length; i += 1) {
      const previous = sequences[i - 1] ?? 0;
      expect(sequences[i]).toBe(previous + 1);
    }
  });

  it("stamps a non-decreasing wall-clock time on every envelope", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(labeled, userText("go"), ready);

    const timestamps = loggedEnvelopes(store).map((envelope) => envelope.at);
    for (const at of timestamps) expect(at).toBeGreaterThan(0);
    for (let i = 1; i < timestamps.length; i += 1) {
      const previous = timestamps[i - 1] ?? 0;
      expect(timestamps[i]).toBeGreaterThanOrEqual(previous);
    }
  });

  it("stamps a non-empty stepId on the step's output envelope", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(labeled, userText("go"), ready);

    const outputEnvelope = loggedEnvelopes(store).find((envelope) => envelope.type === "output");
    expect(outputEnvelope?.stepId).toBeTruthy();
  });

  it("stamps stepName with the step's declared label", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(labeled, userText("go"), ready);

    const outputEnvelope = loggedEnvelopes(store).find((envelope) => envelope.type === "output");
    expect(outputEnvelope?.stepName).toBe("coder");
  });

  it("stamps a consistent, non-empty threadId across a single-thread run", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(labeled, userText("go"), ready);

    const threadIds = loggedEnvelopes(store)
      .filter((envelope) => envelope.type !== "message")
      .map((envelope) => envelope.threadId);
    expect(threadIds.every((id) => Boolean(id))).toBe(true);
    expect(new Set(threadIds).size).toBe(1);
  });
});
