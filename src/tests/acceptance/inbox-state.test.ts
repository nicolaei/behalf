import { describe, it, expect } from "vitest";
import {
  defineGraph,
  runFlow,
  runtime,
  userText,
  adapters,
  outputs,
  userInput,
} from "../../index.js";
import { neverCalled } from "./support.js";

describe("the inbox reflects pending and consumed input", () => {
  // Deliberately store-level, no graph: this is SessionStore's own contract
  // (submit/inbox), not something that needs a flow to observe.
  it("holds a submitted message until a step consumes it", () => {
    const store = adapters.stores.memoryStore();
    const message = userText("hello");

    store.submit(message);

    expect(store.inbox()).toEqual([message]);
  });

  it("empties once a waitFor step consumes the message", async () => {
    const consumeInbox = defineGraph("consume-inbox", (flow) => {
      const wait = flow.waitFor(userInput("follow-up"));
      const after = flow.step(outputs(() => "done"));
      flow.entry(wait);
      wait.then(after);
      after.then(flow.finish);
    });
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(consumeInbox, userText("go"), ready);
    store.submit({
      role: "user",
      intent: "standard",
      kind: "follow-up",
      content: [{ type: "text", text: "resume" }],
    });
    await done;

    expect(store.inbox()).toEqual([]);
  });
});
