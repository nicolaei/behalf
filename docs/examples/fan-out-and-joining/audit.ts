// The Learn "Fan-out and joining" page's example: three reviewer personas
// run in parallel on their own forked threads over the same prompt, then
// converge on a merge step tagged with join() before a lead step writes the
// final reply. Driven with a scripted ModelPort in audit.test.ts, not a real
// provider, so the fan-out and the join are both actually exercised.

import { defineGraph, outputs, join } from "@behalf-js/core";
import type { Graph, Profile, Model, StepContext } from "@behalf-js/core";

const reviewModel: Model = {
  identifier: "scripted",
  provider: "test",
  contextWindow: 1000,
  reasoning: [],
};

export const securityReviewer: Profile = {
  model: reviewModel,
  system: "Review this change for security issues in one short sentence.",
  tools: [],
};
export const performanceReviewer: Profile = {
  model: reviewModel,
  system: "Review this change for performance issues in one short sentence.",
  tools: [],
};
export const styleReviewer: Profile = {
  model: reviewModel,
  system: "Review this change for style issues in one short sentence.",
  tools: [],
};

/** One reviewer's finding, tagged with its own name so the join step can tell them apart. */
interface Review {
  reviewer: string;
  note: string;
}

function lastAssistantText(context: StepContext): string {
  const last = context.thread.messages.at(-1);
  const block =
    last?.role === "assistant" ? last.content.find((b) => b.type === "text") : undefined;
  return block?.type === "text" ? block.text : "";
}

function reviewStep(reviewer: string, persona: Profile) {
  return async (context: StepContext) => {
    await context.modelCall(persona);
    return context.output({ reviewer, note: lastAssistantText(context) } satisfies Review);
  };
}

// #region fan-out
export const audit: Graph = defineGraph("audit", (flow) => {
  const intake = flow.step(
    outputs((context) => context.thread.messages.at(-1)),
    {
      label: "intake",
    },
  );
  const security = flow.step(reviewStep("security", securityReviewer), { label: "security" });
  const performance = flow.step(reviewStep("performance", performanceReviewer), {
    label: "performance",
  });
  const style = flow.step(reviewStep("style", styleReviewer), { label: "style" });

  flow.entry(intake);
  intake.then([security, performance, style]); // fan out — each on its own forked thread
  // #endregion fan-out

  // #region join
  const merge = flow.step(
    join((context) => context.inputs as Review[]),
    { label: "merge" },
  );
  security.then(merge); // each branch reaches the join by an ordinary edge
  performance.then(merge);
  style.then(merge);
  // #endregion join

  const reply = flow.step(
    outputs((context) => {
      const reviews = context.inputs[0] as Review[];
      const noteFrom = (reviewer: string) =>
        reviews.find((review) => review.reviewer === reviewer)?.note ?? "";
      return {
        summary:
          `security: ${noteFrom("security")} ` +
          `performance: ${noteFrom("performance")} ` +
          `style: ${noteFrom("style")}`,
      };
    }),
    { label: "reply" },
  );
  merge.then(reply);
  reply.then(flow.finish);
});
