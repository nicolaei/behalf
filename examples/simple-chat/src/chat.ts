// M3 — the interactive chat graph, now with real filesystem tools. Each turn
// runs via behalf's own agentTurn: run the model, wait for every tool call
// it made, fold their results into one message, loop until a reply uses no
// tools. The outer chat graph then waits for the next user prompt before
// running another turn, same thread throughout.

import { defineGraph, userInput, agentTurn } from "behalf";
import { fsTools } from "./tools.js";
import type { Profile, Model } from "behalf";

export const DEFAULT_MODEL: Model = {
  identifier: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",
  provider: "anthropic",
  contextWindow: 200_000,
  reasoning: ["off", "medium"],
};

export const assistant: Profile = {
  model: DEFAULT_MODEL,
  system: "You are a helpful assistant.",
  tools: fsTools,
  reasoning: "medium",
};

export const chat = defineGraph("chat", (flow) => {
  const loop = flow.use(agentTurn(assistant));
  const waitForPrompt = flow.waitFor(userInput("follow-up"));
  flow.entry(loop);
  loop.then(waitForPrompt); // turn finished -> wait for the next prompt
  waitForPrompt.then(loop); // new prompt -> run another turn, same thread
});
