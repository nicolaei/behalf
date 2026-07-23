import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText } from "@behalf-js/core";
import type { ModelPort } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { twoWays } from "./two-ways.js";

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

describe("twoWays", () => {
  it("routes to the bug plan when classify reads the thread as a bug", async () => {
    const ready = await runtime({
      models: () => scriptedPort("bug"),
      bindings: [],
      store: memoryStore(),
    });

    const result = await runFlow(twoWays, userText("The submit button does nothing."), ready);

    expect(result).toBe("File a bug: reproduce, isolate, patch.");
  });

  it("routes to the feature plan when classify reads the thread as a feature", async () => {
    const ready = await runtime({
      models: () => scriptedPort("feature"),
      bindings: [],
      store: memoryStore(),
    });

    const result = await runFlow(twoWays, userText("Add a dark mode toggle."), ready);

    expect(result).toBe("Draft a proposal: scope, design, estimate.");
  });
});
