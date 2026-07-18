import { describe, it, expect } from "vitest";
import {
  defineGraph,
  runFlow,
  runtime,
  userText,
  adapters,
  outputs,
  compacts,
} from "../../index.js";
import { storeOnlyRuntime, neverCalled, loggedEventTypes } from "./support.js";

describe("compacting the thread replaces the assembled view", () => {
  const compactThenRead = defineGraph("compact-then-read", (flow) => {
    const compact = flow.step(
      compacts(() => [{ role: "system", content: [{ type: "text", text: "summary" }] }]),
    );
    const read = flow.step(
      outputs((context) => ({
        assembled: context.thread.messages.length,
        keepsOriginal: context.thread.history.length > context.thread.messages.length,
      })),
    );
    flow.entry(compact);
    compact.then(read);
    read.then(flow.finish);
  });

  it("replaces the assembled messages while history keeps the original", async () => {
    const result = await runFlow(compactThenRead, userText("hi"), await storeOnlyRuntime());

    expect(result).toEqual({ assembled: 1, keepsOriginal: true });
  });

  it("appends the initial message, the compaction, then the read step's output", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(compactThenRead, userText("hi"), ready);

    expect(loggedEventTypes(store)).toEqual(["message", "compaction", "output"]);
  });
});
