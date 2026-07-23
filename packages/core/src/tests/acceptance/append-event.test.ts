import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, storeOnlyRuntime, loggedEventTypes, loggedEnvelopes } from "./support.js";

// Needs StepContext/ToolContext.appendEvent to be real — currently missing
// from both context builders. Mirrors openStream's slice from round 1: a
// scoped, thread-aware primitive a step or tool handler calls to commit a
// fact directly, with no delta and no envelope-building of its own.
describe("a step or tool can append a standalone event", () => {
  it("commits a toolCall event from a step via context.appendEvent", async () => {
    const graph = defineGraph("step-appends-event", (flow) => {
      const step = flow.step((context) => {
        context.appendEvent({ correlationId: "1", name: "search", input: { q: "hi" } }, "toolCall");
        return Promise.resolve(context.output("done"));
      });
      flow.entry(step);
      step.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(graph, userText("go"), ready);

    // the log holds the initial message, the appended toolCall, and the
    // step's routed output — three distinct committed events, in order
    expect(loggedEventTypes(store)).toEqual(["message", "toolCall", "output"]);
    const toolCall = loggedEnvelopes(store).find((envelope) => envelope.type === "toolCall");
    expect(toolCall?.event).toEqual({ correlationId: "1", name: "search", input: { q: "hi" } });
  });

  it("scopes the appended event's envelope to the caller's own thread", async () => {
    let callingThreadId: unknown;
    const graph = defineGraph("step-appends-event-thread", (flow) => {
      const step = flow.step((context) => {
        callingThreadId = context.thread.id;
        context.appendEvent({ correlationId: "1", name: "search", input: {} }, "toolCall");
        return Promise.resolve(context.output("done"));
      });
      flow.entry(step);
      step.then(flow.finish);
    });

    const ready = await storeOnlyRuntime();
    await runFlow(graph, userText("go"), ready);

    const toolCall = loggedEnvelopes(ready.store).find((envelope) => envelope.type === "toolCall");
    expect(toolCall?.threadId).toBe(callingThreadId);
  });

  it("commits an event from a tool handler via ToolContext.appendEvent", async () => {
    const echo = tool<{ text: string }, { text: string }>("echo", "Echoes its input.");
    const graph = defineGraph("tool-appends-event", (flow) => {
      const step = flow.step(async (context) =>
        context.output(await context.callTool(echo, { text: "hi" })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({
      models: neverCalled,
      bindings: [
        provide(echo, (input, context) => {
          context.appendEvent({ correlationId: "1", name: "echo", input }, "toolCall");
          return Promise.resolve(input);
        }),
      ],
      store,
    });

    await runFlow(graph, userText("go"), ready);

    const toolCall = loggedEnvelopes(store).find((envelope) => envelope.type === "toolCall");
    expect(toolCall?.event).toEqual({ correlationId: "1", name: "echo", input: { text: "hi" } });
  });
});
