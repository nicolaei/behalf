import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, join, outputs } from "../../index.js";
import type { Waitable, WaitForResult } from "../../index.js";
import { neverCalled } from "./support.js";

// runBranchNode's waitFor handling still unconditionally resolves a branch's
// Waitable to a message kind via messageKindOf, which throws for a
// non-userInput provider. Written now so a fan-out branch parking on a
// signal-based Waitable is pinned down as working, same as the existing
// message-based branch-waitFor capability, before Story 5's implementation
// starts.
describe("a fan-out branch that waits for a signal before joining", () => {
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

  const flow = defineGraph("fan-out-branch-waits-signal", (flowBuilder) => {
    const start = flowBuilder.step(outputs(() => "go"));
    const a = flowBuilder.step(outputs(() => "a"));
    const wait = flowBuilder.waitFor(pingSignal());
    const afterWait = flowBuilder.step(
      outputs((context) => (context.inputs[0] as WaitForResult<{ pong: string }>).result.pong),
    );
    const joinStep = flowBuilder.step(join((context) => context.inputs));
    flowBuilder.entry(start);
    start.then([a, wait]);
    a.then(joinStep);
    wait.then(afterWait);
    afterWait.then(joinStep);
    joinStep.then(flowBuilder.finish);
  });

  it("parks the waiting branch until its signal arrives, then joins with the other branch's output", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(flow, userText("go"), ready);
    store.receive({ kind: "signal", name: "ping", payload: { pong: "yes" } });

    const result = await done;

    expect(result).toEqual(expect.arrayContaining(["a", "yes"]));
    expect(result).toHaveLength(2);
  });
});
