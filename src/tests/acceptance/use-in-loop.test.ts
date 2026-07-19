import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import { neverCalled, textOf } from "./support.js";

describe("re-entering a subgraph after waitFor (the chat pattern)", () => {
  const turn = defineGraph("turn", (flow) => {
    const respond = flow.step(outputs((context) => textOf(context.thread.messages.at(-1))));
    flow.entry(respond);
    respond.then(flow.finish);
  });

  const twoTurnChat = defineGraph("two-turn-chat", (flow) => {
    const first = flow.use(turn);
    const wait = flow.waitFor("follow-up");
    const second = flow.use(turn);
    flow.entry(first);
    first.then(wait);
    wait.then(second);
    second.then(flow.finish);
  });

  it("re-enters the same subgraph after waitFor, resolving with the second turn's result", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(twoTurnChat, userText("first"), ready);
    store.submit({
      role: "user",
      intent: "standard",
      kind: "follow-up",
      content: [{ type: "text", text: "second" }],
    });

    expect(await done).toBe("second");
  });
});
