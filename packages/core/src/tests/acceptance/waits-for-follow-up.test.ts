import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, userInput } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, textOf, loggedEventTypes } from "./support.js";

describe("a graph that waits for the next prompt", () => {
  const twoTurns = defineGraph("two-turns", (flow) => {
    const first = flow.step(outputs((context) => textOf(context.thread.messages.at(-1))));
    const wait = flow.waitFor(userInput("follow-up"));
    const second = flow.step(outputs((context) => textOf(context.thread.messages.at(-1))));
    flow.entry(first);
    first.then(wait);
    wait.then(second);
    second.then(flow.finish);
  });

  it("resumes with the follow-up, not the first message", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // parked at `waitFor`, a follow-up is submitted
    // NOTE: submit timing here is a known open concern — `waitFor` must check the
    // inbox reactively so this resolves regardless of when `submit` is called,
    // not because of lucky ordering.
    const done = runFlow(twoTurns, userText("first"), ready);
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

  it("appends both user messages and one output per turn to the session log", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(twoTurns, userText("first"), ready);
    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "follow-up",
        content: [{ type: "text", text: "second" }],
      },
    });
    await done;

    // loose on exact interleaving — confirm against reference.md's inbox-drain behaviour
    // when this slice is active
    const types = loggedEventTypes(store);
    expect(types.filter((type) => type === "message")).toHaveLength(2);
    expect(types.filter((type) => type === "output")).toHaveLength(2);
  });
});
