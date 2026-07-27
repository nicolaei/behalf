// The Learn "The agent loop" page's example: a persona with one tool, run
// through the library's own `agentTurn` primitive, then looped into an
// interactive chat with a wait point between turns. Driven with a scripted
// ModelPort in chat.test.ts, not a real provider, so both the
// tool-call-then-finish turn shape and the waitFor loop-back (same thread
// across turns) are actually exercised.

import { defineGraph, agentTurn, userInput, tool } from "@behalf-js/core";
import type { Profile, Model, Tool } from "@behalf-js/core";

const chatModel: Model = {
  identifier: "scripted",
  provider: "test",
  contextWindow: 1000,
  reasoning: [],
};

export const lookup: Tool<{ query: string }, { hits: string[] }> = tool(
  "lookup",
  "Look something up.",
);

export const assistant: Profile = {
  model: chatModel,
  system: "You are a helpful assistant with a lookup tool.",
  tools: [lookup],
};

// #region turn
export const turn = agentTurn(assistant);
// #endregion turn

// #region chat
export const chat = defineGraph("chat", (flow) => {
  const loop = flow.use(turn);
  const waitForPrompt = flow.waitFor(userInput("follow-up"));
  flow.entry(loop);
  loop.then(waitForPrompt); // turn finished → wait for the next prompt
  waitForPrompt.then(loop); // new prompt → run another turn, same thread
});
// #endregion chat
