// The Learn "Model ports and bindings" page's example: a minimal, real
// ModelPort implementation and a tool-bindings list assembled from
// standardBindings plus the author's own tool. Driven through a flow and
// exercised directly in sketch.test.ts, not just typechecked.

import { tool, provide, defineGraph, agentTurn } from "@behalf-js/core";
import type { Model, ModelPort, Message, ContentBlock, Binding, Profile, Graph } from "@behalf-js/core";
import { standardBindings } from "@behalf-js/tools";

/** Any `thinking` block already on the last assistant message, unfiltered by content. */
function priorThinking(messages: Message[]): Extract<ContentBlock, { type: "thinking" }>[] {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return [];
  return lastAssistant.content.filter(
    (block): block is Extract<ContentBlock, { type: "thinking" }> => block.type === "thinking",
  );
}

// #region port
export function createEchoPort(model: Model): ModelPort {
  return {
    model,
    async respond(_profile, messages, stream) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const text = lastUser?.content.find((block) => block.type === "text");
      const reply = text?.type === "text" ? `You said: ${text.text}` : "I didn't catch that.";

      stream.delta({ correlationId: "echo-reply", open: "text" });
      stream.delta({ correlationId: "echo-reply", text: reply });
      stream.delta({ correlationId: "echo-reply", close: true });

      return {
        role: "assistant",
        provider: "echo",
        model: model.identifier,
        // Any thinking block already on the thread is forwarded exactly as it
        // arrived: mutating one, even just its text, breaks the token a
        // provider needs to accept it back on a later turn.
        content: [...priorThinking(messages), { type: "text", text: reply }],
        usage: { input: messages.length, output: 1 },
      };
    },
  };
}
// #endregion port

// #region bindings
const lookupOrder = tool<{ orderId: string }, { status: string }>(
  "lookup_order",
  "Looks up an order's shipping status by id",
);

const lookupOrderBinding: Binding = provide(lookupOrder, async ({ orderId }) => ({
  status: `order ${orderId} is in transit`,
}));

export const bindings: Binding[] = [...standardBindings, lookupOrderBinding];
// #endregion bindings

export const echoModel: Model = {
  identifier: "echo-1",
  provider: "echo",
  contextWindow: 8_000,
  reasoning: [],
};

export const support: Profile = {
  model: echoModel,
  system: "You are a support assistant.",
  tools: [lookupOrder],
};

export const supportFlow: Graph = defineGraph("support", (flow) => {
  const turn = flow.use(agentTurn(support));
  flow.entry(turn);
  turn.then(flow.finish);
});
