// M1 — one real, non-interactive model call. No tools, no UI loop (that's M2/M3).

import { defineGraph, runtime, runFlow, userText } from "@behalf-js/core";
import type { Profile, Model } from "@behalf-js/core";
import { createAnthropicPort } from "@behalf-js/models-anthropic";
import { memoryStore } from "@behalf-js/stores";

const DEFAULT_MODEL: Model = {
  identifier: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off", "medium"],
};

const profile: Profile = {
  model: DEFAULT_MODEL,
  system: "You are a helpful assistant.",
  tools: [],
  reasoning: "medium",
};

// `ModelCallResult` (context.modelCall's return value) is only
// `{ usedTools, usage }` — no text. The reply itself lands on
// `context.thread.messages`, the assembled, typed view of the thread;
// read the last message back off it and make the text the step's output.
const sayHello = defineGraph("say-hello", (flow) => {
  const respond = flow.step(async (context) => {
    await context.modelCall(profile);
    const last = context.thread.messages.at(-1);
    const text =
      last?.role === "assistant"
        ? last.content
            .filter(
              (block): block is Extract<typeof block, { type: "text" }> => block.type === "text",
            )
            .map((block) => block.text)
            .join("")
        : "(no assistant text)";
    return context.output(text);
  });
  flow.entry(respond);
  respond.then(flow.finish);
});

async function main() {
  const ready = await runtime({
    models: () => createAnthropicPort(DEFAULT_MODEL),
    bindings: [],
    store: memoryStore(),
  });

  const text = await runFlow(sayHello, userText("Say hello in one sentence."), ready);
  console.log(text);
}

main().catch((error) => {
  console.error("simple-chat M1 failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
