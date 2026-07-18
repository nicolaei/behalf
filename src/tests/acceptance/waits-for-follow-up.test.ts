import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import { neverCalled, textOf, loggedEventTypes } from "./support.js";

describe.skip("a graph that waits for the next prompt", () => {
  function twoTurnGraph() {
    return defineGraph("two-turns", (flow) => {
      const first = flow.step((context) =>
        Promise.resolve(context.output(textOf(context.thread.messages.at(-1)))),
      );
      const wait = flow.waitFor("follow-up");
      const second = flow.step((context) =>
        Promise.resolve(context.output(textOf(context.thread.messages.at(-1)))),
      );
      flow.entry(first);
      first.then(wait);
      wait.then(second);
      second.then(flow.finish);
    });
  }

  it("resumes with the follow-up, not the first message", async () => {
    // given a two-turn graph that waits for a follow-up between turns
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs, parking at `waitFor`, and a follow-up is submitted
    // NOTE: submit timing here is a known open concern — `waitFor` must check the
    // inbox reactively so this resolves regardless of when `submit` is called,
    // not because of lucky ordering.
    const done = runFlow(twoTurnGraph(), userText("first"), ready);
    store.submit({
      role: "user",
      intent: "standard",
      kind: "follow-up",
      content: [{ type: "text", text: "second" }],
    });

    // then the second turn sees the follow-up
    expect(await done).toBe("second");
  });

  it("appends both messages to the session log", async () => {
    // given the same graph, and a store we can inspect after the run
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // when the flow runs and the follow-up is submitted
    const done = runFlow(twoTurnGraph(), userText("first"), ready);
    store.submit({
      role: "user",
      intent: "standard",
      kind: "follow-up",
      content: [{ type: "text", text: "second" }],
    });
    await done;

    // then the log holds both user messages and one output per turn
    // (loose on exact interleaving — confirm against reference.md's inbox-drain behaviour
    // when this slice is active)
    const types = loggedEventTypes(store);
    expect(types.filter((type) => type === "message")).toHaveLength(2);
    expect(types.filter((type) => type === "output")).toHaveLength(2);
  });
});
