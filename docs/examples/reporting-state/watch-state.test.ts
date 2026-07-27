import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { trafficLight } from "./traffic-light.js";
import { collectStateChanges } from "./watch-state.js";

function neverCalled(): never {
  throw new Error("no model call expected in this example");
}

describe("collectStateChanges", () => {
  it("reads stateChange transitions live, without importing the graph that produced them", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // Subscribed before the flow runs, so nothing committed in the same tick
    // is missed — the same ordering rule every `store.changes()` consumer
    // depends on.
    const collected = collectStateChanges(store, 3);

    const done = runFlow(trafficLight, userText("go"), ready);
    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "approval",
        content: [{ type: "text", text: "yes" }],
      },
    });
    await done;

    expect(await collected).toEqual([
      { to: "red" },
      { from: "red", to: "yellow" },
      { from: "yellow", to: "green" },
    ]);
  });
});
