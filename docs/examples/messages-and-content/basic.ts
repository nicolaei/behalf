// The Learn "Messages and content" page's example: concrete Message and
// ContentBlock literals, one per role and per block kind. These are plain
// data, not a running flow: basic.test.ts asserts their shape and the
// toolCall/toolResult correlationId pairing directly, since there's no
// behavior to drive through a graph here.

import type { Message, UserMessage } from "@behalf-js/core";

// #region message
export const systemMessage: Message = {
  role: "system",
  content: [{ type: "text", text: "You are a support triage agent." }],
};

export const userMessage: Message = {
  role: "user",
  intent: "standard",
  content: [
    { type: "text", text: "My invoice total looks wrong, see the screenshot." },
    { type: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAUA" },
  ],
};

export const assistantMessage: Message = {
  role: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5",
  usage: { input: 42, output: 18 },
  content: [
    { type: "text", text: "Let me check that invoice." },
    { type: "toolCall", correlationId: "call-1", name: "lookup_invoice", input: { id: "INV-204" } },
  ],
};

export const toolMessage: Message = {
  role: "tool",
  content: [
    { type: "toolResult", correlationId: "call-1", output: { total: 84.5, currency: "USD" } },
  ],
};
// #endregion message

// #region user-message
export const steeringMessage: UserMessage = {
  role: "user",
  intent: "steering",
  kind: "follow-up",
  content: [{ type: "text", text: "Actually, check the tax line too." }],
};
// #endregion user-message

// #region thinking-block
export const assistantWithThinking: Message = {
  role: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5",
  usage: { input: 50, output: 30, reasoning: 12 },
  content: [
    {
      type: "thinking",
      text: "Checking whether the invoice's tax line matches the customer's region.",
      signature: "opaque-round-trip-token",
    },
    { type: "text", text: "The tax line is correct for a California customer." },
  ],
};
// #endregion thinking-block
