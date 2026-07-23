import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText } from "@behalf-js/core";
import type { ModelPort } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { triage, triageErrorHandlers } from "./triage.js";

/** A scripted ModelPort that always replies with the given text, no network. */
function scriptedPort(replyText: string): ModelPort {
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
    respond: () =>
      Promise.resolve({
        role: "assistant",
        provider: "test",
        model: "scripted",
        content: [{ type: "text", text: replyText }],
        usage: { input: 1, output: 1 },
      }),
  };
}

describe("triage", () => {
  it("resolves automatically when the model doesn't escalate", async () => {
    const ready = await runtime({
      models: () => scriptedPort("RESOLVE"),
      bindings: [],
      store: memoryStore(),
      errorHandlers: triageErrorHandlers,
    });

    const result = await runFlow(triage, userText("How do I reset my password?"), ready);

    expect(result).toEqual({ reply: "Resolved automatically." });
  });

  it("waits for a human reply, then responds using it, on the same thread", async () => {
    const store = memoryStore();
    const ready = await runtime({
      models: () => scriptedPort("ESCALATE"),
      bindings: [],
      store,
      errorHandlers: triageErrorHandlers,
    });

    const done = runFlow(triage, userText("My account was hacked."), ready);
    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "human-reply",
        content: [{ type: "text", text: "Reset done, account is secure." }],
      },
    });

    expect(await done).toEqual({
      reply: "Escalated with a human reply: Reset done, account is secure.",
    });
  });
});
