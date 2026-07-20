import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, join, outputs } from "../../index.js";
import { neverCalled, textOf } from "./support.js";

describe("a fan-out branch that waits for a message before joining", () => {
  const flow = defineGraph("fan-out-branch-waits", (flowBuilder) => {
    const start = flowBuilder.step(outputs(() => "go"));
    const a = flowBuilder.step(outputs(() => "a"));
    const wait = flowBuilder.waitFor("approval");
    const afterWait = flowBuilder.step(
      outputs((context) => textOf(context.thread.messages.at(-1))),
    );
    const joinStep = flowBuilder.step(join((context) => context.inputs));
    flowBuilder.entry(start);
    start.then([a, wait]);
    a.then(joinStep);
    wait.then(afterWait);
    afterWait.then(joinStep);
    joinStep.then(flowBuilder.finish);
  });

  it("parks the waiting branch until its message arrives, then joins with the other branch's output", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(flow, userText("go"), ready);
    store.submit({
      role: "user",
      intent: "standard",
      kind: "approval",
      content: [{ type: "text", text: "yes" }],
    });

    const result = await done;

    expect(result).toEqual(expect.arrayContaining(["a", "yes"]));
    expect(result).toHaveLength(2);
  });
});
