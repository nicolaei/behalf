import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Waitable, WaitForResult } from "../../index.js";
import { neverCalled } from "./support.js";

// The unified message-or-signal pending queue and the signal Event kind
// don't exist yet — `store.receive` isn't implemented. Written now so the
// contract is pinned down before Story 2's implementation starts:
// waitFor works for any Waitable, not just userInput, and a signal's payload
// reaches the downstream step without ever touching thread.messages.
describe("waitFor on a signal-based Waitable resumes with the right value", () => {
  // A hand-rolled Waitable, not userInput — proves waitFor is driven by the
  // Waitable contract itself, not by anything message-shaped.
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

  it("resumes with the signal's payload once something external pushes it", async () => {
    const flow = defineGraph("signal-wait", (flowBuilder) => {
      const wait = flowBuilder.waitFor(pingSignal());
      const after = flowBuilder.step(
        outputs((context) => {
          const result = context.inputs[0] as WaitForResult<{ pong: string }>;
          return result.result.pong;
        }),
      );
      flowBuilder.entry(wait);
      wait.then(after);
      after.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(flow, userText("go"), ready);
    // Simulates an external WaitableSource adapter pushing a fact onto the
    // log — no test code touches the inbox directly here, matching how a
    // real timer/webhook source would notify the engine.
    store.receive({ kind: "signal", name: "ping", payload: { pong: "hello" } });

    expect(await done).toBe("hello");
  });

  it("never folds the signal into thread.messages", async () => {
    const flow = defineGraph("signal-wait-thread", (flowBuilder) => {
      const wait = flowBuilder.waitFor(pingSignal());
      const after = flowBuilder.step(outputs((context) => context.thread.messages.length));
      flowBuilder.entry(wait);
      wait.then(after);
      after.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(flow, userText("go"), ready);
    store.receive({ kind: "signal", name: "ping", payload: { pong: "hello" } });

    // Only the initial userText("go") — the signal never joined the thread.
    expect(await done).toBe(1);
  });
});
