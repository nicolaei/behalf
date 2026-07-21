import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText, adapters } from "../../index.js";
import type { Message, ModelCallResult, ModelPort, Profile, Tool } from "../../index.js";
import { loggedEnvelopes } from "./support.js";

// runModelCall still executes every requested tool call inline, synchronously
// (unchanged from today) — this story is only about the request side:
// committing one toolCall event per call the model just asked for, and
// surfacing each one's correlationId/name on the step's own output, so a
// later story's forEach can know exactly which toolCall(id) Waitables to
// wait on without parsing the reply's own ContentBlocks.
describe.skip("runModelCall commits toolCall events and outputs correlationIds", () => {
  // Deferred to a factory, not built at describe-scope: `tool()` isn't real
  // yet, and a describe body runs even when its `it`s are skipped.
  function scriptedFixture() {
    const echo = tool<{ text: string }, { text: string }>("echo", "Echoes text.");
    const shout = tool<{ text: string }, { text: string }>("shout", "Shouts text.");
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () =>
        Promise.resolve({
          role: "assistant",
          provider: "test",
          model: "scripted",
          content: [
            { type: "toolCall", correlationId: "call-a", name: "echo", input: { text: "hi" } },
            { type: "toolCall", correlationId: "call-b", name: "shout", input: { text: "yo" } },
          ],
          usage: { input: 1, output: 1 },
        } satisfies Message),
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [echo, shout] };
    const flow = defineGraph("model-call-owns-request", (flowBuilder) => {
      const respond = flowBuilder.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flowBuilder.entry(respond);
      respond.then(flowBuilder.finish);
    });
    return { flow, scriptedPort, echo, shout };
  }

  function bindingsFor(
    echo: Tool<{ text: string }, { text: string }>,
    shout: Tool<{ text: string }, { text: string }>,
  ) {
    return [
      provide(echo, (input) => Promise.resolve(input)),
      provide(shout, (input: { text: string }) =>
        Promise.resolve({ text: input.text.toUpperCase() }),
      ),
    ];
  }

  it("commits one toolCall event per requested call, with correct fields", async () => {
    const { flow, scriptedPort, echo, shout } = scriptedFixture();
    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: bindingsFor(echo, shout),
      store,
    });

    await runFlow(flow, userText("go"), ready);

    const toolCallEvents = loggedEnvelopes(store).filter(
      (envelope) => envelope.type === "toolCall",
    );
    expect(toolCallEvents.map((envelope) => envelope.event)).toEqual([
      { correlationId: "call-a", name: "echo", input: { text: "hi" } },
      { correlationId: "call-b", name: "shout", input: { text: "yo" } },
    ]);
  });

  it("returns toolCalls with correlationId and name for every call requested this turn", async () => {
    const { flow, scriptedPort, echo, shout } = scriptedFixture();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: bindingsFor(echo, shout),
      store: adapters.stores.memoryStore(),
    });

    const result = (await runFlow(flow, userText("go"), ready)) as ModelCallResult;

    expect(result.toolCalls).toEqual([
      { correlationId: "call-a", name: "echo" },
      { correlationId: "call-b", name: "shout" },
    ]);
  });
});
