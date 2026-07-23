import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText } from "../../index.js";
import { fakePort } from "@behalf-js/testing";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, assistantToolCall } from "./support.js";

// Needs ToolContext.correlationId to be real — currently missing from
// ToolContext entirely, so a handler has no way to correlate its own
// progress stream(s) back to the toolCall/toolResult pair the engine
// committed for it.
describe("a tool handler sees its own call's correlationId", () => {
  it("matches the correlationId the engine committed for this call's toolCall/toolResult", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    let seenCorrelationId: string | undefined;

    const graph = defineGraph("tool-context-correlation-id", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall({ ...profile(), tools: [search] })),
      );
      flow.entry(respond);
      respond.then(flow.finish);
    });

    function profile() {
      return { model: fakePort.model, system: "test persona", tools: [] };
    }

    const store = memoryStore();
    const ready = await runtime({
      models: () => ({
        model: fakePort.model,
        respond: () => Promise.resolve(assistantToolCall("search", { query: "x" })),
      }),
      bindings: [
        provide(search, (input, context) => {
          seenCorrelationId = context.correlationId;
          return Promise.resolve({ hits: [input.query] });
        }),
      ],
      store,
    });

    await runFlow(graph, userText("go"), ready);

    const toolCallEnvelope = store
      .events()
      .find((e) => e.form === "committed" && e.type === "toolCall");
    expect(toolCallEnvelope).toBeDefined();
    const toolCallId =
      toolCallEnvelope?.form === "committed" && toolCallEnvelope.type === "toolCall"
        ? (toolCallEnvelope.event as { correlationId: string }).correlationId
        : undefined;

    expect(seenCorrelationId).toBe(toolCallId);
  });

  it("callTool (direct step invocation, no model in the loop) still gives the handler a correlationId", async () => {
    const echo = tool<{ text: string }, { text: string }>("echo", "Echoes its input.");
    let seenCorrelationId: string | undefined;

    const graph = defineGraph("call-tool-correlation-id", (flow) => {
      const step = flow.step(async (context) =>
        context.output(await context.callTool(echo, { text: "hi" })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });

    const ready = await runtime({
      models: neverCalled,
      bindings: [
        provide(echo, (input, context) => {
          seenCorrelationId = context.correlationId;
          return Promise.resolve(input);
        }),
      ],
      store: memoryStore(),
    });

    await runFlow(graph, userText("go"), ready);

    expect(typeof seenCorrelationId).toBe("string");
    expect(seenCorrelationId?.length).toBeGreaterThan(0);
  });
});
