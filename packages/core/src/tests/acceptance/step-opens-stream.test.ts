import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, loggedEventTypes } from "./support.js";

// Every scenario here needs context.openStream to be real — it's currently a
// notImplemented stub in both the main-loop and branch StepContext builders.
// Written now so the shape is pinned down before that slice starts.
describe("a step can open its own stream", () => {
  it("commits an event to the log when the opened stream is committed", async () => {
    const graph = defineGraph("opens-and-commits-stream", (flow) => {
      const emit = flow.step((context) => {
        const stream = context.openStream("output");
        stream.delta({ correlationId: "1", text: "partial" });
        stream.commit({ value: "done" });
        return Promise.resolve(context.output("done"));
      });
      flow.entry(emit);
      emit.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(graph, userText("go"), ready);

    // then the log holds the initial message, the step's own committed stream,
    // and the step's routed output — three distinct committed events
    expect(loggedEventTypes(store)).toEqual(["message", "output", "output"]);
  });

  it("broadcasts a delta from the opened stream to changes() subscribers, without persisting it", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const graph = defineGraph("opens-stream-delta", (flow) => {
      const emit = flow.step((context) => {
        const stream = context.openStream("output");
        stream.delta({ correlationId: "1", text: "partial" });
        stream.abort();
        return Promise.resolve(context.output("done"));
      });
      flow.entry(emit);
      emit.then(flow.finish);
    });

    const received = (async () => {
      // filter to the delta form: a changes() subscriber attached before runFlow
      // also sees the run's own initial "message" commit broadcast first, which
      // isn't what this scenario is about.
      for await (const envelope of store.changes()) {
        if (envelope.form === "delta") return envelope;
      }
      throw new Error("changes() completed without yielding a delta envelope");
    })();

    await runFlow(graph, userText("go"), ready);

    // then a delta pushed via context.openStream reaches a changes() subscriber,
    // and the delta itself never lands in the committed log
    expect((await received).form).toBe("delta");
  });
});
