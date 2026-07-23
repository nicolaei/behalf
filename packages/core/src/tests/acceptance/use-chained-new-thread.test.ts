import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

// Existing coverage proves "plain step -> new thread -> use" (use-thread-new.test.ts)
// and "use -> same thread -> use" (use-in-loop.test.ts). Neither proves the shape a
// multi-agent pipeline actually needs: one used subgraph's own output feeding a fresh,
// isolated thread for the NEXT used subgraph — the asker -> red -> green -> refactor
// composition. This closes that gap.

describe("use(subgraph A) -> new thread -> use(subgraph B)", () => {
  const subgraphA = defineGraph("subgraph-a", (flow) => {
    const step = flow.step(
      outputs((context) => `A saw ${String(context.thread.messages.length)} message(s)`),
    );
    flow.entry(step);
    step.then(flow.finish);
  });

  const subgraphB = defineGraph("subgraph-b", (flow) => {
    const step = flow.step(
      outputs((context) => ({
        messageCount: context.thread.messages.length,
        messages: context.thread.messages,
      })),
    );
    flow.entry(step);
    step.then(flow.finish);
  });

  const pipeline = defineGraph("pipeline", (flow) => {
    const a = flow.use(subgraphA);
    const b = flow.use(subgraphB);
    flow.entry(a);
    a.then(b, { threadAction: "new", prompt: (value) => userText(String(value)) });
    b.then(flow.finish);
  });

  it("gives B a brand-new thread, seeded only from A's own output — not A's history", async () => {
    const result = await runFlow(pipeline, userText("go"), await storeOnlyRuntime());

    expect(result).toMatchObject({ messageCount: 1 }); // only the seed message — A's history is not present
    expect(
      (result as { messages: { content: { text: string }[] }[] }).messages[0]?.content[0]?.text,
    ).toBe(
      "A saw 1 message(s)", // B's one message is built from A's output, not A's own messages
    );
  });
});
