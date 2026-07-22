// The graph: asker -> red -> green -> refactor. Each stage is its own
// agentTurn, run on a fresh thread (threadAction: "new") — the model never
// sees a stage's own tool-call chatter, only the previous stage's own result,
// carried forward through each edge's `prompt` transform.

import { defineGraph, agentTurn, userText } from "behalf";
import type { AgentTurnResult } from "behalf";
import { askerProfile, redProfile, greenProfile, refactorProfile } from "./profiles.js";

function reportOf(result: AgentTurnResult): string {
  return result.finishedBy === "toolCall" ? JSON.stringify(result.output) : result.text;
}

export const pipeline = defineGraph("multi-step-agent", (flow) => {
  const asker = flow.use(
    agentTurn(askerProfile, { finishOn: [{ on: "toolCall", name: "submit_spec" }] }),
  );
  const red = flow.use(agentTurn(redProfile));
  const green = flow.use(agentTurn(greenProfile));
  const refactor = flow.use(agentTurn(refactorProfile));

  flow.entry(asker);
  asker.then(red, {
    threadAction: "new",
    prompt: (output) =>
      userText(`Write a failing test for this page:\n\n${reportOf(output as AgentTurnResult)}`),
  });
  red.then(green, {
    threadAction: "new",
    prompt: (output) =>
      userText(`Make this test pass:\n\n${reportOf(output as AgentTurnResult)}`),
  });
  green.then(refactor, {
    threadAction: "new",
    prompt: (output) =>
      userText(`Refactor this passing implementation:\n\n${reportOf(output as AgentTurnResult)}`),
  });
  refactor.then(flow.finish);
});
