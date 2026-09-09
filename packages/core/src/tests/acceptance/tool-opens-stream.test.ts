import { describe, it, expect } from "vitest";
import { ai, defineGraph, runtime, provide, tool, userText } from "../../index.js";
import type { Envelope } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, loggedEnvelopes } from "./support.js";
import { runToCompletion } from "@behalf-js/testing";

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
      store,
      extensions: [
        ai({
          models: neverCalled,
          bindings: [
            provide(echo, (input, context) => {
              const stream = context.openStream("output");
              stream.commit({ value: `echoed: ${input.text}` });
              return Promise.resolve(input);
            }),
          ],
        }),
      ],
    });

    await runToCompletion(graph, userText("go"), ready);

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
      store,
      extensions: [
        ai({
          models: neverCalled,
          bindings: [
            provide(echo, (input, context) => {
              const stream = context.openStream("output");
              stream.commit({ value: `echoed: ${input.text}` });
              return Promise.resolve(input);
            }),
          ],
        }),
      ],
    });

    await runToCompletion(graph, userText("go"), ready);

    const committed = loggedEnvelopes(store).find(
      (envelope) =>
        envelope.type === "output" &&
        JSON.stringify(envelope.event) === JSON.stringify({ value: "echoed: hi" }),
    );
    expect(committed?.threadId).toBe(callingThreadId);
  });

  // A TOOL'S LIVE OUTPUT HAS TO BE MATCHABLE TO THE CALL THAT PRODUCED IT.
  //
  // `openStream` mints a fresh correlationId, so a tool streaming its progress
  // labels it with an id nothing else in the log has ever mentioned. A reader
  // folding that log sees text under an unknown id and can only treat it as
  // the model talking — the tool's own row stays a spinner while its output
  // lands in the assistant's sentence.
  //
  // The context already holds the right id: `correlationId`, "this call's own
  // correlationId, shared by its toolCall/toolResult pair". A tool that passes
  // it gets its deltas labelled with it, and one id then runs down the whole
  // call — the call, its output as it happens, and its result.
  it("streams under the call's own correlationId when the tool asks for it", async () => {
    const echo = tool<{ text: string }, { text: string }>("echo", "Echoes its input.");
    let callId = "";
    const graph = defineGraph("tool-streams-under-its-call", (flow) => {
      const step = flow.step(async (context) =>
        context.output(await context.callTool(echo, { text: "hi" })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });
    const store = memoryStore();

    // Deltas are broadcast and never logged, so they are watched rather than
    // read back — the same way a browser watches them.
    const seen: Envelope[] = [];
    void (async () => {
      for await (const envelope of store.changes()) seen.push(envelope);
    })();

    const ready = await runtime({
      store,
      extensions: [
        ai({
          models: neverCalled,
          bindings: [
            provide(echo, (input, context) => {
              callId = context.correlationId;
              const stream = context.openStream("output", context.correlationId);
              stream.delta({ correlationId: context.correlationId, text: "half done" });
              stream.commit({ value: input.text });
              return Promise.resolve(input);
            }),
          ],
        }),
      ],
    });

    await runToCompletion(graph, userText("go"), ready);
    // One turn of the event loop, so the subscriber above has drained.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const streamed = seen.filter((envelope) => envelope.form === "delta");
    expect(streamed.map((envelope) => envelope.correlationId)).toEqual([callId]);
  });
});
