import { describe, it, expect } from "vitest";
import {
  defineGraph,
  runFlow,
  runtime,
  userText,
  outputs,
  satisfiesFlows,
  userInput,
} from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Waitable, WaitForResult, WaitableSource } from "../../index.js";
import { FlowNotReadyError } from "../../index.js";
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

describe("a registered WaitableSource satisfies a flow end-to-end", () => {
  // Already true with the existing signal machinery — a WaitableSource is
  // just an application-level convenience wrapping store.receive; this
  // confirms the shape composes, not a new engine capability by itself.
  it("resolves once the source pushes its signal onto the store", async () => {
    const fakeSource: WaitableSource = {
      provider: "test-signal",
      start(store) {
        store.receive({ kind: "signal", name: "ping", payload: { pong: "hi" } });
        return () => undefined; // no real resource to tear down in this fake
      },
    };

    const flow = defineGraph("waitable-source-e2e", (flowBuilder) => {
      const wait = flowBuilder.waitFor(pingSignal());
      const after = flowBuilder.step(
        outputs((context) => (context.inputs[0] as WaitForResult<{ pong: string }>).result.pong),
      );
      flowBuilder.entry(wait);
      wait.then(after);
      after.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    fakeSource.start(store);
    const result = await runFlow(flow, userText("go"), ready);

    expect(result).toBe("hi");
  });
});

// satisfiesFlows doesn't yet walk a flow's waitFor/interrupt nodes collecting
// Waitable providers — the signature already accepts a waitableSources
// resolver (mirroring `models`'s shape) but the body ignores it. Written now
// so the boot-check contract is pinned down before Story 6's implementation
// starts.
describe("satisfiesFlows reports a missing Waitable provider", () => {
  const flow = defineGraph("needs-test-signal", (flowBuilder) => {
    const wait = flowBuilder.waitFor(pingSignal());
    flowBuilder.entry(wait);
    wait.then(flowBuilder.finish);
  });

  it("reports the provider missing when no source resolves it", () => {
    const missing = satisfiesFlows([flow], neverCalled, [], () => undefined);

    expect(missing).toContainEqual({ kind: "waitable", provider: "test-signal" });
  });

  it("reports nothing missing once a source resolves the provider", () => {
    const fakeSource: WaitableSource = { provider: "test-signal", start: () => () => undefined };
    const missing = satisfiesFlows([flow], neverCalled, [], (provider) =>
      provider === "test-signal" ? fakeSource : undefined,
    );

    expect(missing).toEqual([]);
  });

  it("never reports userInput as missing — it needs no registered source", () => {
    const userInputFlow = defineGraph("needs-user-input", (flowBuilder) => {
      const wait = flowBuilder.waitFor(userInput("resume"));
      flowBuilder.entry(wait);
      wait.then(flowBuilder.finish);
    });

    const missing = satisfiesFlows([userInputFlow], neverCalled, [], () => undefined);

    expect(missing).not.toContainEqual({ kind: "waitable", provider: "userInput" });
  });
});

describe("FlowNotReadyError", () => {
  it("is a real Error carrying the missing list", () => {
    const missing = [{ kind: "waitable" as const, provider: "test-signal" }];
    const error = new FlowNotReadyError(missing);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FlowNotReadyError);
    expect(error.missing).toEqual(missing);
    expect(error.message).toContain("test-signal");
  });
});
