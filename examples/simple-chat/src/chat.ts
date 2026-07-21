// M3 — the interactive chat graph, now with real filesystem tools. One
// persona step, looped: run a turn, wait for the next prompt, run again, all
// on the same thread (the default), so context carries across turns. A turn
// finishes once a response uses no tools (see docs/reference.md § "Full
// examples" #1); otherwise it loops back to respond again so the model can
// see the tool results and continue.

import { defineGraph, userInput } from "behalf";
import { fsTools } from "./tools.js";
import type { Profile, PersonaStep, StepContext, ModelCallResult, Model } from "behalf";

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

const modelStep = (profile: Profile): PersonaStep<ModelCallResult> =>
  Object.assign(async (context: StepContext) => context.output(await context.modelCall(profile)), {
    persona: profile,
  });

const agentTurn = (persona: Profile) =>
  defineGraph(persona.system, (flow) => {
    const respond = flow.step(modelStep(persona));
    flow.entry(respond);
    // A response that used no tools ends the turn; otherwise loop back so the
    // model can see the committed tool results and keep going.
    respond
      .when((result) => !(result as ModelCallResult).usedTools, flow.finish)
      .otherwise(respond);
  });

export const chat = defineGraph("chat", (flow) => {
  const loop = flow.use(agentTurn(assistant));
  const waitForPrompt = flow.waitFor(userInput("follow-up"));
  flow.entry(loop);
  loop.then(waitForPrompt); // turn finished -> wait for the next prompt
  waitForPrompt.then(loop); // new prompt -> run another turn, same thread
});
