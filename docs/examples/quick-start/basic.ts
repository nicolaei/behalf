import { defineGraph, agentTurn, userText, runtime, runFlow } from "@behalf-js/core";
import type { Profile, Model } from "@behalf-js/core";
import { createAnthropicPort } from "@behalf-js/models-anthropic";
import { memoryStore } from "@behalf-js/stores";

const sonnet5: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off", "medium"],
};

const assistant: Profile = {
  model: sonnet5,
  system: "You are a helpful assistant.",
  tools: [],
};

export const workflow = defineGraph("support", (flow) => {
  const turn = flow.use(agentTurn(assistant));
  flow.entry(turn);
  turn.then(flow.finish);
});

const ready = await runtime({
  models: () => createAnthropicPort(sonnet5),
  bindings: [],
  store: memoryStore(),
});

const result = await runFlow(workflow, userText("Say hello world in one sentence."), ready);
console.log(result);
