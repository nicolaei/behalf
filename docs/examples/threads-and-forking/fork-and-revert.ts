// The Learn "Threads and forking" page's example: a small draft/review loop
// that exercises all three ThreadActions in one graph. `draft.then(review)`
// is the default (`same`): the review continues on the same thread as the
// draft. A rejected review forks back to `draft`, seeded with the review's
// feedback as the new thread's prompt — a revert that keeps the draft's own
// history reachable but starts the retry from a clean slate plus the note on
// what to fix. An approved review routes to `notify` on a brand-new thread
// (`new`), since notify only needs the final approved text, not the whole
// draft/review back-and-forth. Driven with a scripted ModelPort in
// fork-and-revert.test.ts, so all three actions are actually exercised.

import { defineGraph, userText } from "@behalf-js/core";
import type { Graph, Profile, Model, StepContext } from "@behalf-js/core";

const draftModel: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off"],
};

const drafter: Profile = {
  model: draftModel,
  system: "Write a one-sentence changelog entry for the described change.",
  tools: [],
};

const reviewer: Profile = {
  model: draftModel,
  system:
    'Review the draft above. Reply "approve: <the draft>" if it is ready, or ' +
    '"reject: <feedback>" with what to fix.',
  tools: [],
};

function lastAssistantText(context: StepContext): string {
  const last = context.thread.messages.at(-1);
  const block =
    last?.role === "assistant" ? last.content.find((b) => b.type === "text") : undefined;
  return block?.type === "text" ? block.text : "";
}

interface Verdict {
  approved: boolean;
  text: string;
}

function readVerdict(context: StepContext): Verdict {
  const reply = lastAssistantText(context);
  if (reply.toLowerCase().startsWith("approve:")) {
    return { approved: true, text: reply.slice("approve:".length).trim() };
  }
  return { approved: false, text: reply.slice("reject:".length).trim() };
}

export const draftReview: Graph = defineGraph("fork-and-revert", (flow) => {
  const draft = flow.step(async (context) => {
    await context.modelCall(drafter);
    return context.output(lastAssistantText(context));
  });

  const review = flow.step(async (context) => {
    await context.modelCall(reviewer);
    return context.output(readVerdict(context));
  });

  const notify = flow.step(async (context) => {
    const verdict = context.inputs[0] as Verdict;
    return context.output(`Notified: ${verdict.text}`);
  });

  flow.entry(draft);

  // #region actions
  draft.then(review); // same (default) — review continues the draft's own thread

  review.when((output) => (output as Verdict).approved, notify, {
    threadAction: "new", // deliberate reset — notify only needs the final text
    prompt: (output) => userText((output as Verdict).text),
  });

  // #region revert
  review.otherwise(draft, {
    threadAction: "fork", // revert — split onto a new thread, seeded with feedback
    prompt: (output) => userText((output as Verdict).text),
  });
  // #endregion revert
  // #endregion actions

  notify.then(flow.finish);
});
