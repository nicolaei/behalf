import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, userInput } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Waitable } from "../../index.js";
import { neverCalled, loggedEventTypes } from "./support.js";

// An interrupt still only races against a message-based waitFor by flattening
// every armed Waitable into a message-kind list — a signal-based interrupt
// makes that flattening throw instead of racing. Written now so the priority
// rule (interrupt beats a plain waitFor, whichever's condition is satisfied
// first wins) is pinned down for a genuinely heterogeneous race before
// Story 4's implementation starts.
describe("a signal-based interrupt wins over a userInput waitFor when it fires first", () => {
  function pingSignal(): Waitable<{ pong: string }> {
    return {
      provider: "test-signal",
      label: "ping",
      match(events) {
        for (const envelope of events) {
          if (envelope.form !== "committed" || envelope.type !== "signal") continue;
          const event = envelope.event as { name: string; payload?: unknown };
          if (event.name === "ping") return event.payload as { pong: string };
        }
        return undefined;
      },
    };
  }

  const withSignalInterrupt = defineGraph("with-signal-interrupt", (flow) => {
    const wait = flow.waitFor(userInput("resume"));
    const afterWait = flow.step(outputs(() => "resumed"));
    const cancelled = flow.interrupt(
      pingSignal(),
      outputs(() => "cancelled"),
    );
    flow.entry(wait);
    wait.then(afterWait);
    afterWait.then(flow.finish);
    cancelled.then(flow.finish);
  });

  it("bypasses the waiting path when the interrupt's signal arrives instead of the waited-for message", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(withSignalInterrupt, userText("go"), ready);
    store.receive({ kind: "signal", name: "ping", payload: { pong: "hi" } });

    expect(await done).toBe("cancelled");
  });

  it("appends the interrupt's output to the session log", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(withSignalInterrupt, userText("go"), ready);
    store.receive({ kind: "signal", name: "ping", payload: { pong: "hi" } });
    await done;

    expect(loggedEventTypes(store)).toContain("output");
  });

  it("still resumes the normal waitFor path when a matching message arrives instead of a signal", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(withSignalInterrupt, userText("go"), ready);
    store.receive({
      kind: "message",
      message: { role: "user", intent: "standard", kind: "resume", content: [] },
    });

    expect(await done).toBe("resumed");
  });
});
