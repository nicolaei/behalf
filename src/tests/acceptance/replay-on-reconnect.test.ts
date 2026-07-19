import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { neverCalled, loggedEnvelopes } from "./support.js";

describe("a late reader replays the full committed log", () => {
  const graph = defineGraph("two-events", (flow) => {
    const step = flow.step(outputs(() => "done"));
    flow.entry(step);
    step.then(flow.finish);
  });

  it("returns every committed envelope, in order, to a reader who connects after the run", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(graph, userText("go"), ready);

    // a "late reader" — connects only now, after the flow has already finished
    const replay = loggedEnvelopes(store);
    expect(replay).toHaveLength(2); // message, output

    // the spec calls `sequence` a "per-session ordinal" without pinning down a
    // starting value — only strict ordering is certain
    const sequences = replay.map((envelope) => envelope.sequence);
    for (let i = 1; i < sequences.length; i += 1) {
      const previous = sequences[i - 1] ?? 0;
      expect(sequences[i]).toBeGreaterThan(previous);
    }
  });
});
