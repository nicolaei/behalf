import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { storeOnlyRuntime, neverCalled, loggedEventTypes } from "./support.js";

describe("compacting the thread replaces the assembled view", () => {
  const compactThenRead = defineGraph("compact-then-read", (flow) => {
    const compact = flow.step(async (context) => {
      await context.compact({
        summary: { role: "system", content: [{ type: "text", text: "summary" }] },
        keepLast: 1,
      });
      return context.output(true);
    });
    const read = flow.step(
      outputs((context) => ({
        assembled: context.thread.messages.length,
        keepsOriginal: context.thread.history.length > 0,
      })),
    );
    flow.entry(compact);
    compact.then(read);
    read.then(flow.finish);
  });

  it("replaces the assembled messages with the summary plus the kept tail", async () => {
    const result = await runFlow(compactThenRead, userText("hi"), await storeOnlyRuntime());

    // summary + the 1 kept message (the seed) — history itself is untouched by compaction.
    expect(result).toEqual({ assembled: 2, keepsOriginal: true });
  });

  it("appends the initial message, the compaction, the compact step's own output, then the read step's output", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(compactThenRead, userText("hi"), ready);

    expect(loggedEventTypes(store)).toEqual(["message", "compaction", "output", "output"]);
  });
});
