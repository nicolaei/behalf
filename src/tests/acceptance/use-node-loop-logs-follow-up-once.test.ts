import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, userInput, adapters } from "../../index.js";
import { neverCalled, loggedEnvelopes } from "./support.js";

// Mirrors examples/simple-chat's chat graph shape: a `use` node as the
// entry, looping back to itself through a waitFor. The first message is
// fixed (use-node-entry-logs-once.test.ts) — this covers the second visit:
// waitFor resolves a follow-up message, routes back to the same `use` node,
// and seedUseNode's fallback branch (a non-message "waitFor satisfied"
// marker, resolving to the thread's last message) re-logs a message that
// driveWaitForMessage already committed one line earlier.
describe("a use node looped back through a waitFor", () => {
  it("logs a follow-up message once, not twice", async () => {
    const inner = defineGraph("inner", (flow) => {
      const step = flow.step((context) => Promise.resolve(context.output("done")));
      flow.entry(step);
      step.then(flow.finish);
    });
    const outer = defineGraph("outer-use-loop", (flow) => {
      const loop = flow.use(inner);
      const wait = flow.waitFor(userInput("follow-up"));
      flow.entry(loop);
      loop.then(wait);
      wait.then(loop); // loops forever — never reaches finish, by design
    });

    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // Fire-and-forget: this graph never finishes, so we never await it.
    runFlow(outer, userText("hi"), ready).catch(() => {
      // ignore — nothing here throws in this scenario
    });

    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "follow-up",
        content: [{ type: "text", text: "second" }],
      },
    });

    // No model calls, no timers, no real I/O anywhere in this graph — give
    // the engine a short window to process the follow-up and whatever else
    // happens immediately after, long enough to catch a duplicate commit.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const messageEvents = loggedEnvelopes(store).filter((e) => e.type === "message");
    expect(messageEvents).toHaveLength(2); // the initial prompt + one follow-up
  });
});
