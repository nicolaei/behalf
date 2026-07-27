// The Learn "Wiring a graph" page's example: reference.md's own three-reviewer
// audit. One intake step fans out to three reviewer personas, each on its own
// forked thread; they converge on a `join()`-tagged merge step, which a reply
// step turns into one recommendation. Driven with a scripted ModelPort per
// branch in audit.test.ts, so the merge step's assertion can tell which
// review said what. Every step carries an explicit `label`, so the generated
// diagram (see graphToMermaid) reads as "security"/"performance"/etc. instead of
// an auto-assigned node id.

import { defineGraph, join, outputs } from "@behalf-js/core";
import type { Graph, Profile, Model, StepContext } from "@behalf-js/core";

const reviewModel: Model = {
  identifier: "scripted",
  provider: "test",
  contextWindow: 1_000_000,
  reasoning: ["off"],
};

function reviewer(system: string): Profile {
  return { model: reviewModel, system, tools: [] };
}

const securityReviewer = reviewer("Review this change for security issues. Reply in one sentence.");
const performanceReviewer = reviewer(
  "Review this change for performance issues. Reply in one sentence.",
);
const styleReviewer = reviewer("Review this change for style issues. Reply in one sentence.");

function lastAssistantText(context: StepContext): string {
  const last = context.thread.messages.at(-1);
  const block =
    last?.role === "assistant" ? last.content.find((b) => b.type === "text") : undefined;
  return block?.type === "text" ? block.text : "";
}

export const audit: Graph = defineGraph("audit", (flow) => {
  const intake = flow.step(
    outputs((context) => context.inputs[0]),
    { label: "intake" },
  );

  const security = flow.step(
    async (context) => {
      await context.modelCall(securityReviewer);
      return context.output(lastAssistantText(context));
    },
    { label: "security" },
  );
  const performance = flow.step(
    async (context) => {
      await context.modelCall(performanceReviewer);
      return context.output(lastAssistantText(context));
    },
    { label: "performance" },
  );
  const style = flow.step(
    async (context) => {
      await context.modelCall(styleReviewer);
      return context.output(lastAssistantText(context));
    },
    { label: "style" },
  );

  // reads the merged reviews from context.inputs[0] — one entry per branch
  const reply = flow.step(
    outputs((context) => {
      const reviews = context.inputs[0] as string[];
      return `Recommendation: ${reviews.join(" ")}`;
    }),
    { label: "reply" },
  );

  // #region graph
  flow.entry(intake);

  // #region fan-out
  intake.then([security, performance, style]);
  // #endregion fan-out

  // #region join
  const merge = flow.step(
    join((context) => context.inputs),
    { label: "merge" },
  );
  security.then(merge);
  performance.then(merge);
  style.then(merge);
  // #endregion join

  // #region edges
  merge.then(reply);
  reply.then(flow.finish);
  // #endregion edges
  // #endregion graph
});
