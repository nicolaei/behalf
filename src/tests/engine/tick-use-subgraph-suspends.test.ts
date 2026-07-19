import { describe, it, expect } from "vitest";
import { tickUntilSuspended } from "../../engine/runtime.js";
import { defineGraph, runtime, userText, adapters, outputs } from "../../index.js";
import { neverCalled, textOf } from "../acceptance/support.js";

// Needs tick() to genuinely suspend inside a used subgraph's own waitFor —
// today's guard only covers the shallow case (the subgraph's entry node
// itself being an unready waitFor) and throws notImplemented for anything
// deeper, like this one where the waitFor comes after an intermediate step.
describe("ticking a flow through a used subgraph that itself waits", () => {
  const inner = defineGraph("tick-use-inner-wait", (flow) => {
    const echo = flow.step(
      outputs((context) => textOf(context.thread.messages.at(-1)).toUpperCase()),
    );
    const wait = flow.waitFor("approval");
    const respond = flow.step(outputs(() => "approved-done"));
    flow.entry(echo);
    echo.then(wait);
    wait.then(respond);
    respond.then(flow.finish);
  });

  const outer = defineGraph("tick-use-outer-wait", (flow) => {
    const start = flow.step(outputs(() => "hi"));
    const sub = flow.use(inner);
    flow.entry(start);
    start.then(sub, { prompt: (value) => userText(String(value)) });
    sub.then(flow.finish);
  });

  it("reports the used subgraph's own waitFor as a parked cursor, resumable across tick calls", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const parked = await tickUntilSuspended(outer, ready);
    expect(parked).toHaveLength(1);
    expect(parked).toMatchObject([{ status: "parked", waitingFor: ["approval"] }]);

    store.submit({
      role: "user",
      intent: "standard",
      kind: "approval",
      content: [{ type: "text", text: "yes" }],
    });

    const resumed = await tickUntilSuspended(outer, ready);
    expect(resumed).toHaveLength(1);
    expect(resumed).toMatchObject([{ status: "done", result: "approved-done" }]);
  });
});
