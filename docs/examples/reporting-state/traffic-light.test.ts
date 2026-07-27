import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText } from "@behalf-js/core";
import type { Event } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { trafficLight } from "./traffic-light.js";

function neverCalled(): never {
  throw new Error("no model call expected in this example");
}

function stateChanges(store: { events(): readonly unknown[] }): Event["stateChange"][] {
  const changes: Event["stateChange"][] = [];
  for (const envelope of store.events() as { form: string; type: string; event: unknown }[]) {
    if (envelope.form !== "committed" || envelope.type !== "stateChange") continue;
    changes.push(envelope.event as Event["stateChange"]);
  }
  return changes;
}

describe("trafficLight", () => {
  it("emits one stateChange per real transition: red, then yellow, then green", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

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

    expect(stateChanges(store)).toEqual([
      { to: "red" },
      { from: "red", to: "yellow" },
      { from: "yellow", to: "green" },
    ]);
  });
});
