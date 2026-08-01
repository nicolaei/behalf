import { describe, it, expect } from "vitest";
import { tickUntilSuspended } from "@behalf-js/core/internal";
import { seed } from "../../index.js";
import { ai, defineGraph, runtime, userText, outputs, userInput } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { textOf, submitApproval, neverCalled } from "../acceptance/support.js";

// Needs tick() to genuinely suspend inside a used subgraph's own waitFor —
// today's guard only covers the shallow case (the subgraph's entry node
// itself being an unready waitFor) and throws notImplemented for anything
// deeper, like this one where the waitFor comes after an intermediate step.
describe("ticking a flow through a used subgraph that itself waits", () => {
  const inner = defineGraph("tick-use-inner-wait", (flow) => {
    const echo = flow.step(
      outputs((context) => textOf(context.thread.messages.at(-1)).toUpperCase()),
    );
    const wait = flow.waitFor(userInput("approval"));
    const respond = flow.step(outputs(() => "approved-done"));
    flow.entry(echo);
    echo.then(wait);
    wait.then(respond);
    respond.then(flow.finish);
  });

  let subNodeId!: string;
  const outer = defineGraph("tick-use-outer-wait", (flow) => {
    const start = flow.step(outputs(() => "hi"));
    const sub = flow.use(inner);
    subNodeId = sub.id;
    flow.entry(start);
    start.then(sub, {
      run: (value, ctx) => {
        ctx.thread.say(userText(String(value)));
        return value;
      },
    });
    sub.then(flow.finish);
  });

  it("reports the used subgraph's own waitFor as a parked cursor, resumable across tick calls", async () => {
    const store = memoryStore();
    const ready = await runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });
    seed(outer, undefined, ready);

    const parked = await tickUntilSuspended(outer, ready);
    expect(parked).toHaveLength(1);
    expect(parked).toMatchObject([{ status: "parked", waitingFor: ["approval"] }]);
    expect((parked[0] as { parent?: unknown }).parent).toBe(subNodeId);

    submitApproval(store);

    const resumed = await tickUntilSuspended(outer, ready);
    expect(resumed).toHaveLength(1);
    expect(resumed).toMatchObject([{ status: "done", result: "approved-done" }]);
  });
});
