import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText } from "@behalf-js/core";
import type { ModelPort, Message } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { chat } from "./chat.js";

/** A scripted ModelPort that replies once per call, cycling through the given texts.
 * Built once per test and reused via `models: () => port`, since `runtime.models()`
 * is called fresh on every model call: a factory that builds a new `ModelPort` (and
 * a new `call` closure) each time would replay the first reply forever. */
function scriptedPort(replies: string[]): ModelPort {
  let call = 0;
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
    respond: () => {
      const text = replies[call] ?? replies.at(-1) ?? "";
      call += 1;
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

function assistantTexts(store: { events(): readonly unknown[] }): string[] {
  const texts: string[] = [];
  for (const envelope of store.events() as { form: string; type: string; event: unknown }[]) {
    if (envelope.form !== "committed" || envelope.type !== "message") continue;
    const message = (envelope.event as { message: Message }).message;
    if (message.role !== "assistant") continue;
    const block = message.content.find((candidate) => candidate.type === "text");
    if (block?.type === "text") texts.push(block.text);
  }
  return texts;
}

describe("chat", () => {
  it("loops back to respond on a follow-up prompt, then stops on an interrupt", async () => {
    const store = memoryStore();
    const port = scriptedPort(["Hello!", "Why did the chicken cross the road?"]);
    const ready = await runtime({
      models: () => port,
      bindings: [],
      store,
    });

    const done = runFlow(chat, userText("Hi"), ready);

    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "follow-up",
        content: [{ type: "text", text: "Tell me a joke." }],
      },
    });

    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "stop",
        content: [{ type: "text", text: "That's enough." }],
      },
    });

    expect(await done).toBe("Conversation ended.");
    // Both scripted replies were actually used — the loop-back really called
    // respond a second time, not just replayed the first reply.
    expect(assistantTexts(store)).toEqual([
      "Hello!",
      "Why did the chicken cross the road?",
    ]);
  });
});
