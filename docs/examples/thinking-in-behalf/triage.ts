// The Learn "Thinking in behalf" page's example: a support-ticket triage
// agent, designed with the five-step methodology the page walks through.
// Driven with a scripted ModelPort in triage.test.ts, not a real provider,
// so its behavior (both branches, the wait point, the error handler's
// wiring) is actually exercised by a test.

import { defineGraph, userInput, outputs } from "@behalf-js/core";
import type {
  Graph,
  Profile,
  Model,
  StepContext,
  UserMessage,
  ErrorHandler,
} from "@behalf-js/core";

const triageModel: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off"],
};

const triagePersona: Profile = {
  model: triageModel,
  system:
    'Read this support ticket and reply with exactly one word: "RESOLVE" if you can answer it ' +
    'directly, "ESCALATE" if it needs a person.',
  tools: [],
};

function lastAssistantText(context: StepContext): string {
  const last = context.thread.messages.at(-1);
  const block =
    last?.role === "assistant" ? last.content.find((b) => b.type === "text") : undefined;
  return block?.type === "text" ? block.text : "";
}

// #region shape
export const triage: Graph = defineGraph("triage", (flow) => {
  const classify = flow.step(
    async (context) => {
      await context.modelCall(triagePersona);
      const reply = lastAssistantText(context).trim();
      if (reply !== "RESOLVE" && reply !== "ESCALATE") {
        return context.fail({
          type: "validation",
          message: `expected "RESOLVE" or "ESCALATE", got "${reply}"`,
        });
      }
      return context.output({ decision: reply === "ESCALATE" ? "escalate" : "resolve" });
    },
    { label: "triage" },
  );

  const autoResolve = flow.step(
    outputs(() => ({ reply: "Resolved automatically." })),
    { label: "auto-resolve" },
  );

  // #region wait-point
  const waitForHuman = flow.waitFor(userInput("human-reply"));
  // #endregion wait-point

  const respond = flow.step(
    outputs((context) => {
      const reply = context.thread.messages.at(-1) as UserMessage;
      const text = reply.content.find((block) => block.type === "text");
      return { reply: `Escalated with a human reply: ${text?.type === "text" ? text.text : ""}` };
    }),
    { label: "respond" },
  );

  flow.entry(classify);
  classify
    .when((output) => (output as { decision: string }).decision === "escalate", waitForHuman)
    .otherwise(autoResolve);
  // #endregion shape

  // #region threading
  waitForHuman.then(respond, { threadAction: "same" });
  // #endregion threading

  autoResolve.then(flow.finish);
  respond.then(flow.finish);
});

// #region error-handling
export const triageErrorHandlers: ErrorHandler[] = [
  (error, context) => {
    // A malformed classification is never worth retrying: fail fast instead
    // of spending the default handler's retry budget on the same bad reply.
    if (error.type === "validation" && context.attempts === 0) return { action: "fail" };
    return undefined; // defer to runtime()'s built-in default for everything else
  },
];
// #endregion error-handling
