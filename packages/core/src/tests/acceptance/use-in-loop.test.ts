import { describe, it, expect } from "vitest";
import { ai, defineGraph, runtime, userText, outputs, userInput } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { textOf, neverCalled } from "./support.js";
import { runToCompletion } from "@behalf-js/testing";

describe("re-entering a subgraph after waitFor (the chat pattern)", () => {
  const turn = defineGraph("turn", (flow) => {
    const respond = flow.step(outputs((context) => textOf(context.thread.messages.at(-1))));
    flow.entry(respond);
    respond.then(flow.finish);
  });

  const twoTurnChat = defineGraph("two-turn-chat", (flow) => {
    const first = flow.use(turn);
    const wait = flow.waitFor(userInput("follow-up"));
    const second = flow.use(turn);
    flow.entry(first);
    first.then(wait);
    wait.then(second);
    second.then(flow.finish);
  });

  it("re-enters the same subgraph after waitFor, resolving with the second turn's result", async () => {
    const store = memoryStore();
    const ready = await runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });

    const done = runToCompletion(twoTurnChat, userText("first"), ready);
    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "follow-up",
        content: [{ type: "text", text: "second" }],
      },
    });

    expect(await done).toBe("second");
  });
});
