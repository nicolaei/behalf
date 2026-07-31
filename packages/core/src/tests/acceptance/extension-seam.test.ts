import { describe, it, expect } from "vitest";
import { defineGraph, runtime, runFlow, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Waitable, WaitForResult, WaitableSource, EngineExtension } from "../../index.js";
import { neverCalled } from "./support.js";

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

describe("runtime({ extensions }) folds an extension's waitables into its registration path", () => {
  // An extension contributes a WaitableSource the same way a caller could start one by hand
  // today (see waitable-source.test.ts) — this proves runtime() itself now starts it, from
  // config alone, with no separate `source.start(store)` call required.
  it("starts an extension's WaitableSource so its park condition gets satisfied", async () => {
    const fakeSource: WaitableSource = {
      provider: "test-signal",
      start(store) {
        store.receive({ kind: "signal", name: "ping", payload: { pong: "hi" } });
        return () => undefined;
      },
    };
    const extension: EngineExtension = { name: "test-ext", waitables: [fakeSource] };

    const flow = defineGraph("extension-seam-e2e", (flowBuilder) => {
      const wait = flowBuilder.waitFor(pingSignal());
      const after = flowBuilder.step(
        outputs((context) => (context.inputs[0] as WaitForResult<{ pong: string }>).result.pong),
      );
      flowBuilder.entry(wait);
      wait.then(after);
      after.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store, extensions: [extension] });

    const result = await runFlow(flow, userText("go"), ready);

    expect(result).toBe("hi");
  });
});
