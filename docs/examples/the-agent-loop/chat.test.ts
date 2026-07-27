import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText, provide } from "@behalf-js/core";
import type { ModelPort, AssistantMessage, Message } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { chat, assistant, lookup } from "./chat.js";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

function assistantToolCall(name: string, input: unknown): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "toolCall", correlationId: "1", name, input }],
    usage: { input: 1, output: 1 },
  };
}

/** Polls until `predicate` is true, for waiting on a running flow's side effects. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("chat", () => {
  it("runs a tool-call-then-finish turn, then loops on the same thread after the next prompt", async () => {
    const capturedMessages: Message[][] = [];
    let calls = 0;
    const port: ModelPort = {
      model: assistant.model,
      respond: (_profile, messages) => {
        capturedMessages.push(messages);
        calls += 1;
        if (calls === 1) return Promise.resolve(assistantToolCall("lookup", { query: "tides" }));
        if (calls === 2) return Promise.resolve(assistantText("The tide is out this morning."));
        return Promise.resolve(assistantText("Tomorrow it's back in by noon."));
      },
    };

    const store = memoryStore();
    const ready = await runtime({
      models: () => port,
      bindings: [provide(lookup, () => Promise.resolve({ hits: ["tide table"] }))],
      store,
    });

    // The chat graph loops forever (it's an interactive session, not a
    // one-shot computation), so this promise is deliberately never awaited
    // to completion; the assertions below watch its side effects instead.
    void runFlow(chat, userText("When's the tide out?"), ready);

    await waitUntil(() => calls === 2);
    expect(capturedMessages[1]?.some((m) => m.role === "tool")).toBe(true); // the tool result folded in

    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "follow-up",
        content: [{ type: "text", text: "And tomorrow?" }],
      },
    });

    await waitUntil(() => calls === 3);
    const thirdCallMessages = capturedMessages[2] ?? [];
    const sawFirstPrompt = thirdCallMessages.some((m) =>
      m.content.some((block) => block.type === "text" && block.text === "When's the tide out?"),
    );
    expect(sawFirstPrompt).toBe(true); // same thread: the second turn still sees the first prompt
  });
});
