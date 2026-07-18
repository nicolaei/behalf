import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import { storeOnlyRuntime, neverCalled, loggedEventTypes } from "./support.js";

describe.skip("compaction", () => {
  const compactThenRead = defineGraph("compact-then-read", (flow) => {
    const compact = flow.step((context) =>
      Promise.resolve(
        context.compact(() =>
          Promise.resolve([{ role: "system", content: [{ type: "text", text: "summary" }] }]),
        ),
      ),
    );
    const read = flow.step((context) =>
      Promise.resolve(
        context.output({
          assembled: context.thread.messages.length,
          keepsOriginal: context.thread.history.length > context.thread.messages.length,
        }),
      ),
    );
    flow.entry(compact);
    compact.then(read);
    read.then(flow.finish);
  });

  it("replaces the assembled messages while history keeps the original", async () => {
    // given the graph above
    // when the flow runs
    const result = await runFlow(compactThenRead, userText("hi"), await storeOnlyRuntime());

    // then the assembled view is just the summary; history still has more than that
    expect(result).toEqual({ assembled: 1, keepsOriginal: true });
  });

  it("appends a compaction event to the session log", async () => {
    // given the graph above, and a store we can inspect after the run
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs
    await runFlow(compactThenRead, userText("hi"), ready);

    // then the log holds the initial message, the compaction, then the read step's output
    // (confirm this exact shape against reference.md's compaction behaviour when this slice is active)
    expect(loggedEventTypes(store)).toEqual(["message", "compaction", "output"]);
  });
});
