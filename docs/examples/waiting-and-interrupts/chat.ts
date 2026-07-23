// The Learn "Waiting and interrupts" page's example: a small chat graph.
// `respond` calls the model, then `waitFor(userInput("follow-up"))` parks for
// the next prompt and loops back — reference.md's own `chat` shape. An
// `interrupt` on a "stop" kind is always armed alongside it: whichever
// message kind arrives first wins the race, so a "stop" message ends the
// conversation instead of looping back to `respond`. Driven with a scripted
// ModelPort in chat.test.ts, so both the loop and the interrupt are actually
// exercised.

import { defineGraph, userInput, outputs } from "@behalf-js/core";
import type { Graph, Profile, Model, StepContext } from "@behalf-js/core";

const chatModel: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off"],
};

const assistant: Profile = {
  model: chatModel,
  system: "You are a helpful assistant.",
  tools: [],
};

function lastAssistantText(context: StepContext): string {
  const last = context.thread.messages.at(-1);
  const block =
    last?.role === "assistant" ? last.content.find((b) => b.type === "text") : undefined;
  return block?.type === "text" ? block.text : "";
}

export const chat: Graph = defineGraph("chat", (flow) => {
  const respond = flow.step(async (context) => {
    await context.modelCall(assistant);
    return context.output(lastAssistantText(context));
  });

  // #region wait-for
  const waitForPrompt = flow.waitFor(userInput("follow-up"));
  // #endregion wait-for

  const stopped = flow.step(outputs(() => "Conversation ended."));
  const stop = flow.interrupt(userInput("stop"), outputs(() => undefined));

  flow.entry(respond);
  respond.then(waitForPrompt);

  // #region user-input
  waitForPrompt.then(respond);
  // #endregion user-input

  stop.then(stopped);
  stopped.then(flow.finish);
});
