import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, loggedEnvelopes } from "./support.js";

// Needs ToolContext.openStream to be wired for real — currently a
// notImplemented stub in buildToolContext. Mirrors StepContext.openStream's
// slice from round 1.
describe("a tool handler opening its own stream", () => {
  it("commits an event to the log via the tool's own opened stream", async () => {
    const echo = tool<{ text: string }, { text: string }>("echo", "Echoes its input.");
    const graph = defineGraph("tool-opens-stream", (flow) => {
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
          const stream = context.openStream("output");
          stream.commit({ value: `echoed: ${input.text}` });
          return Promise.resolve(input);
        }),
      ],
      store,
    });

    await runFlow(graph, userText("go"), ready);

    const committed = loggedEnvelopes(store).find(
      (envelope) =>
        envelope.type === "output" &&
        JSON.stringify(envelope.event) === JSON.stringify({ value: "echoed: hi" }),
    );
    expect(committed).toBeDefined();
  });

  it("scopes the opened stream's envelope to the tool's calling thread", async () => {
    const echo = tool<{ text: string }, { text: string }>("echo", "Echoes its input.");
    let callingThreadId: unknown;
    const graph = defineGraph("tool-opens-stream-thread", (flow) => {
      const step = flow.step(async (context) => {
        callingThreadId = context.thread.id;
        return context.output(await context.callTool(echo, { text: "hi" }));
      });
      flow.entry(step);
      step.then(flow.finish);
    });
    const store = memoryStore();
    const ready = await runtime({
      models: neverCalled,
      bindings: [
        provide(echo, (input, context) => {
          const stream = context.openStream("output");
          stream.commit({ value: `echoed: ${input.text}` });
          return Promise.resolve(input);
        }),
      ],
      store,
    });

    await runFlow(graph, userText("go"), ready);

    const committed = loggedEnvelopes(store).find(
      (envelope) =>
        envelope.type === "output" &&
        JSON.stringify(envelope.event) === JSON.stringify({ value: "echoed: hi" }),
    );
    expect(committed?.threadId).toBe(callingThreadId);
  });
});
