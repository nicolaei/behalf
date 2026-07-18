import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import type { Message, ModelCallResult, Profile } from "../../index.js";
import { fakePortRuntime, loggedEventTypes, loggedEventAt } from "./support.js";

describe("a step that calls the model", () => {
  // Deferred to a factory, not built at describe-scope: `fakePort` isn't real
  // yet, and a describe body runs even when its `it`s are skipped.
  function respondOnceGraph() {
    const profile: Profile = {
      model: adapters.models.fakePort.model,
      system: "test persona",
      tools: [],
    };
    return defineGraph("respond-once", (flow) => {
      const respond = flow.step(async (context) => {
        const result = await context.modelCall(profile);
        return context.output({ result, reply: context.thread.messages.at(-1) });
      });
      flow.entry(respond);
      respond.then(flow.finish);
    });
  }

  it("appends the model's reply to the thread and reports no tool use", async () => {
    const { result, reply } = (await runFlow(
      respondOnceGraph(),
      userText("hi"),
      await fakePortRuntime(),
    )) as {
      result: ModelCallResult;
      reply?: Message;
    };

    expect(result.usedTools).toBe(false);
    expect(reply?.role).toBe("assistant");
  });

  it("appends the initial message, the model's reply, then the step's output", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: () => adapters.models.fakePort, bindings: [], store });

    await runFlow(respondOnceGraph(), userText("hi"), ready);

    expect(loggedEventTypes(store)).toEqual(["message", "message", "output"]);
    expect(loggedEventAt(store, 1).event).toMatchObject({ message: { role: "assistant" } });
  });
});
