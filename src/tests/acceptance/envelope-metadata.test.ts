import { describe, it, expect, beforeEach } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import type { SessionStore } from "../../index.js";
import { neverCalled, loggedEnvelopes } from "./support.js";

describe("envelope metadata: sequence, at, stepId, stepName, threadId", () => {
  // Two steps, not one — a single-envelope run can't tell "consistent across
  // envelopes" apart from "there was only one to begin with".
  const labeled = defineGraph("labeled", (flow) => {
    const coder = flow.step(
      outputs(() => "step-one"),
      { label: "coder" },
    );
    const second = flow.step(outputs(() => "done"));
    flow.entry(coder);
    coder.then(second);
    second.then(flow.finish);
  });

  let store: SessionStore;

  beforeEach(async () => {
    store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(labeled, userText("go"), ready);
  });

  it("stamps a strictly increasing, unique sequence on every envelope", () => {
    // the spec calls `sequence` a "per-session ordinal" without pinning down a
    // starting value or promising no gaps — only strict ordering is certain
    const sequences = loggedEnvelopes(store).map((envelope) => envelope.sequence);
    for (let i = 1; i < sequences.length; i += 1) {
      const previous = sequences[i - 1] ?? 0;
      expect(sequences[i]).toBeGreaterThan(previous);
    }
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("stamps a non-decreasing wall-clock time on every envelope", () => {
    const timestamps = loggedEnvelopes(store).map((envelope) => envelope.at);
    for (const at of timestamps) expect(at).toBeGreaterThan(0);
    for (let i = 1; i < timestamps.length; i += 1) {
      const previous = timestamps[i - 1] ?? 0;
      expect(timestamps[i]).toBeGreaterThanOrEqual(previous);
    }
  });

  it("stamps a non-empty stepId on a step's output envelope", () => {
    const outputEnvelope = loggedEnvelopes(store).find((envelope) => envelope.type === "output");
    expect(outputEnvelope?.stepId).toBeTruthy();
  });

  it("stamps stepName with the step's declared label", () => {
    // assumes `label` (Threads) and `stepName` (Envelope) carry the same value —
    // the spec describes the two separately and never states this mapping explicitly
    const outputEnvelope = loggedEnvelopes(store).find((envelope) => envelope.type === "output");
    expect(outputEnvelope?.stepName).toBe("coder");
  });

  it("stamps a consistent threadId on every envelope that has one", () => {
    // threadId is `threadId?: ThreadId` in the spec — explicitly optional — so
    // this only checks agreement among envelopes that DO carry one, not
    // universal presence
    const threadIds = loggedEnvelopes(store)
      .map((envelope) => envelope.threadId)
      .filter((id): id is NonNullable<typeof id> => Boolean(id));
    expect(new Set(threadIds).size).toBeLessThanOrEqual(1);
  });
});
