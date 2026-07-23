import { describe, it, expect } from "vitest";
import { runtime, runFlow, userText, satisfiesPersonas } from "@behalf-js/core";
import type { Message } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { createEchoPort, echoModel, bindings, support, supportFlow } from "./sketch.js";

const noopStream = { delta: () => undefined };

describe("createEchoPort", () => {
  it("replies to the last user message", async () => {
    const port = createEchoPort(echoModel);
    const messages: Message[] = [userText("What's the weather?")];

    const reply = await port.respond(support, messages, noopStream);

    expect(reply.content).toEqual([{ type: "text", text: "You said: What's the weather?" }]);
  });

  it("forwards a prior thinking block unmodified", async () => {
    const port = createEchoPort(echoModel);
    const thinkingBlock = {
      type: "thinking" as const,
      text: "considering options",
      signature: "sig-1",
    };
    const messages: Message[] = [
      userText("Hi"),
      {
        role: "assistant",
        provider: "echo",
        model: "echo-1",
        content: [thinkingBlock],
        usage: { input: 1, output: 1 },
      },
      userText("Go on"),
    ];

    const reply = await port.respond(support, messages, noopStream);

    // Same object, not a re-serialized copy: the port never touches it.
    expect(reply.content[0]).toBe(thinkingBlock);
  });
});

describe("bindings", () => {
  it("resolves every tool the support persona declares", () => {
    const missing = satisfiesPersonas([support], () => createEchoPort(echoModel), bindings);

    expect(missing).toEqual([]);
  });
});

describe("running the flow", () => {
  it("drives a full turn through the echo port and the assembled bindings", async () => {
    const ready = await runtime({
      models: () => createEchoPort(echoModel),
      bindings,
      store: memoryStore(),
    });

    const result = await runFlow(supportFlow, userText("Hello there"), ready);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "You said: Hello there" });
  });
});
