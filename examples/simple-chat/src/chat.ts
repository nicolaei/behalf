// M2 — the interactive chat graph. One persona step, looped: run a turn, wait
// for the next prompt, run again, all on the same thread (the default), so
// context carries across turns. No tools yet, so every model response
// finishes the turn immediately (see docs/reference.md § "Full examples" #1).

import { defineGraph, userInput } from "behalf";
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
  tools: [],
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
    // No tools bound, so every response finishes the turn.
    respond.then(flow.finish);
  });

export const chat = defineGraph("chat", (flow) => {
  const loop = flow.use(agentTurn(assistant));
  const waitForPrompt = flow.waitFor(userInput("follow-up"));
  flow.entry(loop);
  loop.then(waitForPrompt); // turn finished -> wait for the next prompt
  waitForPrompt.then(loop); // new prompt -> run another turn, same thread
});
