// The Learn "Steps and emits" page's example: reference.md's own "reading
// input two ways" graph. `classify` reads the THREAD (via `modelCall`, then
// `context.thread.messages`); `route` reads the PREVIOUS OUTPUT (via
// `context.inputs[0]`) instead. Driven with a scripted ModelPort in
// two-ways.test.ts, not a real provider, so both routes are actually
// exercised by a test.

import { defineGraph } from "@behalf-js/core";
import type { Graph, Profile, Model, StepContext } from "@behalf-js/core";

const classifierModel: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off"],
};

const classifier: Profile = {
  model: classifierModel,
  system: 'Read this ticket and reply with exactly one word: "bug" or "feature".',
  tools: [],
};

const triagePlan = "File a bug: reproduce, isolate, patch.";
const featurePlan = "Draft a proposal: scope, design, estimate.";

function readLabel(context: StepContext): "bug" | "feature" {
  const last = context.thread.messages.at(-1);
  const block =
    last?.role === "assistant" ? last.content.find((b) => b.type === "text") : undefined;
  const text = block?.type === "text" ? block.text.trim().toLowerCase() : "";
  return text === "feature" ? "feature" : "bug";
}

export const twoWays: Graph = defineGraph("two-ways", (flow) => {
  // #region classify
  const classify = flow.step(async (context) => {
    await context.modelCall(classifier);
    return context.output(readLabel(context));
  });
  // #endregion classify

  // #region route
  const route = flow.step(async (context) => {
    const label = context.inputs[0] as "bug" | "feature";
    return context.output(label === "bug" ? triagePlan : featurePlan);
  });
  // #endregion route

  flow.entry(classify);
  classify.then(route);
  route.then(flow.finish);
});
