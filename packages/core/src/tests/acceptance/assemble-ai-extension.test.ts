// B2.7 — proves the assembled shape end to end: `runtime({ store, extensions:
// [ai({ models, bindings })] })` (not `runtime({ models, bindings, store })`,
// the config shape B2.7 deletes) drives a real model call through a
// ModelPort, resolves a real tool call through the ai extension's decoupled
// tool executor, and folds both into the thread correctly.

import { describe, it, expect } from "vitest";
import { ai, agentTurn, provide, runFlow, runtime, tool, userText } from "../../index.js";
import type { ModelPort, Profile } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { assistantText, assistantToolCall, loggedEventTypes, textOf } from "./support.js";

describe("ai() assembles model calls, the tool executor, and thread folding into one extension", () => {
  it("runs a model turn, a real tool call, and a final reply through runtime({ extensions: [ai(...)] })", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    let calls = 0;
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? assistantToolCall("search", { query: "behalf" })
            : assistantText("Found it."),
        );
      },
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [search] };

    const store = memoryStore();
    const ready = await runtime({
      store,
      extensions: [
        ai({
          models: () => scriptedPort,
          bindings: [
            provide(search, ({ query }) => Promise.resolve({ hits: [`${query}-result`] })),
          ],
        }),
      ],
    });

    const flow = agentTurn(profile);
    const result = await runFlow(flow, userText("look this up"), ready);

    // The model call happened (twice: the tool-requesting turn, then the
    // final reply) and the decoupled tool executor actually resolved the
    // real `search` binding — not left pending.
    expect(calls).toBe(2);
    expect(result).toEqual({ finishedBy: "finalMessage", text: "Found it." });

    const types = loggedEventTypes(store);
    expect(types).toContain("toolCall");
    expect(types).toContain("toolResult");

    // Thread folding: the assistant's tool-call turn, the folded tool
    // result, and the final reply all landed on the thread in order.
    const messages = store
      .events()
      .filter((envelope) => envelope.form === "committed" && envelope.type === "message")
      .map((envelope) => (envelope.event as { message: unknown }).message);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const toolMessage = messages.find(
      (message) => (message as { role: string }).role === "tool",
    ) as { content: { type: string; output: unknown }[] } | undefined;
    expect(toolMessage?.content).toEqual([
      { type: "toolResult", correlationId: "1", output: { hits: ["behalf-result"] } },
    ]);
    const finalMessage = messages.at(-1);
    expect(textOf(finalMessage as never)).toBe("Found it.");
  });
});
