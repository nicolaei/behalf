import { describe, it, expect } from "vitest";
import {
  systemMessage,
  userMessage,
  assistantMessage,
  toolMessage,
  steeringMessage,
  assistantWithThinking,
} from "./basic.js";

describe("messages and content", () => {
  it("gives each role its own content shape", () => {
    expect(systemMessage.role).toBe("system");
    expect(userMessage.role).toBe("user");
    expect(assistantMessage.role).toBe("assistant");
    expect(toolMessage.role).toBe("tool");
  });

  it("carries an image block alongside text on the user message", () => {
    expect(userMessage.content.map((block) => block.type)).toEqual(["text", "image"]);
  });

  it("pairs a toolCall with its toolResult by correlationId", () => {
    const call = assistantMessage.content.find((block) => block.type === "toolCall");
    const result = toolMessage.content.find((block) => block.type === "toolResult");
    expect(call?.type).toBe("toolCall");
    expect(result?.type).toBe("toolResult");
    if (call?.type === "toolCall" && result?.type === "toolResult") {
      expect(result.correlationId).toBe(call.correlationId);
    }
  });

  it("marks a steering message with its intent and routing kind", () => {
    expect(steeringMessage.intent).toBe("steering");
    expect(steeringMessage.kind).toBe("follow-up");
  });

  it("keeps a thinking block's signature next to its visible summary", () => {
    const [thinking, text] = assistantWithThinking.content;
    expect(thinking?.type).toBe("thinking");
    expect(text?.type).toBe("text");
    if (thinking?.type === "thinking") {
      expect(thinking.signature).toBe("opaque-round-trip-token");
      expect(thinking.text.length).toBeGreaterThan(0);
    }
  });
});
