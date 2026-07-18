import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import type { Message, ModelCallResult, Profile } from "../../index.js";
import { fakePortRuntime, loggedEventTypes, loggedEventAt } from "./support.js";

describe.skip("a step that calls the model", () => {
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
    // given the graph above, run through a runtime whose model resolver returns fakePort
    // when the flow runs
    const { result, reply } = (await runFlow(
      respondOnceGraph(),
      userText("hi"),
      await fakePortRuntime(),
    )) as {
      result: ModelCallResult;
      reply?: Message;
    };

    // then the model was called once, used no tools, and its reply is on the thread
    expect(result.usedTools).toBe(false);
    expect(reply?.role).toBe("assistant");
  });

  it("appends the expected events to the session log", async () => {
    // given the graph above, and a store we can inspect after the run
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: () => adapters.models.fakePort, bindings: [], store });

    // when the flow runs
    await runFlow(respondOnceGraph(), userText("hi"), ready);

    // then the log holds the initial message, the model's reply, then the step's output
    // (confirm this exact shape against reference.md's `modelCall` behaviour when this slice is active)
    expect(loggedEventTypes(store)).toEqual(["message", "message", "output"]);
    expect(loggedEventAt(store, 1).event).toMatchObject({ message: { role: "assistant" } });
  });
});
