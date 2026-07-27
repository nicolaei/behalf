import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText } from "@behalf-js/core";
import type { ModelPort, Profile } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { audit } from "./audit.js";

/** A scripted ModelPort that replies differently per persona, keyed by a keyword in
 * its system prompt, so the merge step's assertion can tell which review said what. */
function scriptedPort(): ModelPort {
  const repliesByKeyword: [string, string][] = [
    ["security", "no injection risks found"],
    ["performance", "adds one extra query per request"],
    ["style", "naming is inconsistent in two places"],
  ];
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
    respond: (profile: Profile) => {
      const match = repliesByKeyword.find(([keyword]) => profile.system.includes(keyword));
      const text = match?.[1] ?? "no comment";
      return Promise.resolve({
        role: "assistant",
        provider: "test",
        model: "scripted",
        content: [{ type: "text", text }],
        usage: { input: 1, output: 1 },
      });
    },
  };
}

describe("audit", () => {
  it("fans out to three reviewers and merges their findings into one recommendation", async () => {
    const ready = await runtime({
      models: () => scriptedPort(),
      bindings: [],
      store: memoryStore(),
    });

    const result = await runFlow(audit, userText("Add a search endpoint."), ready);

    expect(result).toBe(
      "Recommendation: no injection risks found adds one extra query per request " +
        "naming is inconsistent in two places",
    );
  });
});
