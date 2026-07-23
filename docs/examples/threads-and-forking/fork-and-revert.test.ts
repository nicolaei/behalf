import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText } from "@behalf-js/core";
import type { ModelPort, Profile, Message } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { draftReview } from "./fork-and-revert.js";

function lastUserText(messages: readonly Message[]): string | undefined {
  const last = messages.at(-1);
  const block = last?.role === "user" ? last.content.find((b) => b.type === "text") : undefined;
  return block?.type === "text" ? block.text : undefined;
}

/** A scripted ModelPort: the drafter always replies with a fixed draft; the reviewer
 * rejects the first time it sees a draft and approves the second, so the graph
 * actually forks-and-retries once before reaching an approval. Records every prompt
 * the drafter is called with, so a test can see what the forked retry was seeded
 * with. Built once per test and reused via `models: () => port`, since
 * `runtime.models()` is called fresh on every model call: a factory that builds a
 * new `ModelPort` (and a new `reviewCalls` closure) each time would forget the
 * review already happened once. */
function scriptedPort(): { port: ModelPort; draftPrompts: string[] } {
  let reviewCalls = 0;
  const draftPrompts: string[] = [];
  const port: ModelPort = {
    model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
    respond: (profile: Profile, messages: Message[]) => {
      const isReviewer = profile.system.startsWith("Review the draft");
      let text: string;
      if (!isReviewer) {
        const prompt = lastUserText(messages);
        if (prompt) draftPrompts.push(prompt);
        text = "Adds a dark mode toggle to settings.";
      } else {
        reviewCalls += 1;
        text =
          reviewCalls === 1
            ? "reject: mention the default is off"
            : "approve: Adds a dark mode toggle to settings, off by default.";
      }
      return Promise.resolve({
        role: "assistant",
        provider: "test",
        model: "scripted",
        content: [{ type: "text", text }],
        usage: { input: 1, output: 1 },
      });
    },
  };
  return { port, draftPrompts };
}

describe("draftReview", () => {
  it("forks back to draft on rejection, then reaches notify on a fresh thread once approved", async () => {
    const { port } = scriptedPort();
    const ready = await runtime({
      models: () => port,
      bindings: [],
      store: memoryStore(),
    });

    const result = await runFlow(draftReview, userText("Add a dark mode toggle."), ready);

    expect(result).toBe(
      "Notified: Adds a dark mode toggle to settings, off by default.",
    );
  });

  it("seeds the forked retry with the review's feedback as its next prompt", async () => {
    const { port, draftPrompts } = scriptedPort();
    const ready = await runtime({
      models: () => port,
      bindings: [],
      store: memoryStore(),
    });

    await runFlow(draftReview, userText("Add a dark mode toggle."), ready);

    // First call: the graph's own entry prompt. Second call: the forked retry,
    // seeded with the rejection's feedback instead of the original request.
    expect(draftPrompts).toEqual([
      "Add a dark mode toggle.",
      "mention the default is off",
    ]);
  });
});
