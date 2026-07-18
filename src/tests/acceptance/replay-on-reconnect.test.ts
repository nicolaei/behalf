import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { neverCalled, loggedEnvelopes } from "./support.js";

describe.skip("a late reader replays the full committed log", () => {
  const graph = defineGraph("three-events", (flow) => {
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
    expect(replay.map((envelope) => envelope.sequence)).toEqual([1, 2]);
  });
});
