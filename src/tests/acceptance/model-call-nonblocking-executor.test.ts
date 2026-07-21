import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText, adapters } from "../../index.js";
import type { ModelCallResult, ModelPort, Profile } from "../../index.js";
import { assistantToolCall, loggedEventTypes, awaitEventType } from "./support.js";

// Story 5 kept runModelCall's tool execution inline and blocking — the model-
// call step doesn't return until every requested tool call is done. That
// means a downstream forEach would never see a genuinely pending tool call:
// by the time forEach's items() runs, everything's already resolved. This
// story changes the contract: runModelCall commits the toolCall requests and
// returns immediately, without waiting for or executing anything itself. A
// separate, registered executor (auto-wired from the same tool bindings)
// watches the log independently and resolves each toolCall on its own.
describe("a decoupled executor resolves tool calls independently of modelCall", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("modelCall returns before a slow tool call finishes; the executor resolves it independently", async () => {
    const slow = tool<{ n: number }, { n: number }>("slow", "A deliberately slow tool.");
    const gate = deferred<{ n: number }>();
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => Promise.resolve(assistantToolCall("slow", { n: 1 })),
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [slow] };
    const flow = defineGraph("model-call-nonblocking", (flowBuilder) => {
      const respond = flowBuilder.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flowBuilder.entry(respond);
      respond.then(flowBuilder.finish);
    });

    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [provide(slow, () => gate.promise)],
      store,
    });

    const resolved = awaitEventType(store, "toolResult");
    const result = (await runFlow(flow, userText("go"), ready)) as ModelCallResult;

    // modelCall's own promise already settled — the tool handler is still
    // gated shut, so nothing has resolved it yet.
    expect(result.toolCalls).toEqual([{ correlationId: "1", name: "slow" }]);
    expect(loggedEventTypes(store)).not.toContain("toolResult");

    gate.resolve({ n: 2 });
    const toolResultEnvelope = await resolved;

    expect(toolResultEnvelope.event).toEqual({ correlationId: "1", output: { n: 2 } });
  });
});
