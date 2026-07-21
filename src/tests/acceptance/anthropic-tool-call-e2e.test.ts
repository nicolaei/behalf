import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText, adapters } from "../../index.js";
import type { Model, Profile } from "../../index.js";
import { loggedEnvelopes } from "./support.js";
import type Anthropic from "@anthropic-ai/sdk";

// Needs createAnthropicPort to accept an injectable client (no network) —
// currently it always builds its own via resolveAuth(process.env). Proves
// the real adapter, not a fakePort, drives the engine's existing tool-call
// machinery end to end: real tool definitions sent, a scripted tool_use
// response mapped to a real toolCall content block, the engine committing
// both toolCall and toolResult events, and the real (test-registered)
// handler actually running.
describe("the real Anthropic port runs a tool call end to end", () => {
  it("commits toolCall and toolResult events and runs the real handler, with no network", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");

    const fakeClient = {
      messages: {
        create: () =>
          Promise.resolve({
            content: [
              { type: "tool_use", id: "call-1", name: "search", input: { query: "weather" } },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      },
    } as unknown as Anthropic;

    const model: Model = {
      identifier: "claude-opus-4-8",
      provider: "anthropic",
      contextWindow: 200_000,
      reasoning: ["off"],
    };
    const port = adapters.models.createAnthropicPort(model, fakeClient);

    const profile: Profile = { model, system: "test persona", tools: [search] };
    const graph = defineGraph("anthropic-tool-call-e2e", (flow) => {
      const step = flow.step(async (context) => {
        const result = await context.modelCall(profile);
        return context.output(result);
      });
      flow.entry(step);
      step.then(flow.finish);
    });

    let handlerRan = false;
    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: () => port,
      bindings: [
        provide(search, (input) => {
          handlerRan = true;
          return Promise.resolve({ hits: [`result for ${input.query}`] });
        }),
      ],
      store,
    });

    await runFlow(graph, userText("what's the weather?"), ready);

    expect(handlerRan).toBe(true);
    const events = loggedEnvelopes(store);
    const toolCall = events.find((e) => e.type === "toolCall");
    const toolResult = events.find((e) => e.type === "toolResult");
    expect(toolCall?.event).toEqual({
      correlationId: "call-1",
      name: "search",
      input: { query: "weather" },
    });
    expect(toolResult?.event).toEqual({
      correlationId: "call-1",
      output: { hits: ["result for weather"] },
    });
  });
});
