import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText } from "@behalf-js/core";
import type { ModelPort, AssistantMessage, Profile } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { audit, securityReviewer, performanceReviewer, styleReviewer } from "./audit.js";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

/** One reply per reviewer persona, told apart by which `system` prompt called it. */
function scriptedPort(): ModelPort {
  const repliesBySystem: Record<string, string> = {
    [securityReviewer.system]: "no hardcoded secrets found.",
    [performanceReviewer.system]: "one query runs in a loop, consider batching.",
    [styleReviewer.system]: "naming is consistent with the rest of the module.",
  };
  return {
    model: securityReviewer.model,
    respond: (profile: Profile) =>
      Promise.resolve(assistantText(repliesBySystem[profile.system] ?? "")),
  };
}

describe("audit", () => {
  it("runs all three reviewers and joins their findings into one reply", async () => {
    const ready = await runtime({
      models: () => scriptedPort(),
      bindings: [],
      store: memoryStore(),
    });

    const result = await runFlow(audit, userText("Review this pull request."), ready);

    expect(result).toEqual({
      summary:
        "security: no hardcoded secrets found. " +
        "performance: one query runs in a loop, consider batching. " +
        "style: naming is consistent with the rest of the module.",
    });
  });

  it("gives each branch its own forked thread, one reviewer's reply never leaking into another's", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: () => scriptedPort(), bindings: [], store });

    await runFlow(audit, userText("Review this pull request."), ready);

    const messageEnvelopes = store
      .events()
      .filter((e) => e.form === "committed" && e.type === "message");
    const threadIds = new Set(messageEnvelopes.map((e) => e.threadId));
    // the initial prompt's thread, plus one forked thread per reviewer
    expect(threadIds.size).toBeGreaterThanOrEqual(4);
  });
});
