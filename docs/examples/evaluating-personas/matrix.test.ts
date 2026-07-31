// The Learn "Evaluating personas" page's example: the real eval/ subpath —
// example() for the case table, built-in scorers plus an injected fake
// Judge, scenario() to gate CI, and explore()+grid() to compare variants
// with several rankers from one execution pass.

import { userText } from "@behalf-js/core";
import type { ModelPort, Profile, AssistantMessage } from "@behalf-js/core";
import {
  agent,
  example,
  outputMatches,
  llmJudge,
  scenario,
  explore,
  grid,
  byScore,
  byTimeToComplete,
  byTokens,
} from "@behalf-js/testing/eval";
import type { Judge } from "@behalf-js/testing/eval";

/** Replies with the next entry in `script`, one call at a time: the same pattern setting-up-fakes.md names `scriptedPort`. */
function scriptedPort(script: AssistantMessage["content"][]): ModelPort {
  let call = 0;
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
    respond: () => {
      const content = script[call];
      if (!content) throw new Error(`scriptedPort: no script entry for call ${String(call + 1)}`);
      call += 1;
      return Promise.resolve({
        role: "assistant",
        provider: "test",
        model: "scripted",
        content,
        usage: { input: 1, output: 1 },
      });
    },
  };
}

interface World {
  ticket: string;
}

// #region agent
const basicProfile: Profile = {
  model: { identifier: "claude-haiku", provider: "test", contextWindow: 100_000, reasoning: [] },
  system:
    'Read this support ticket and reply with exactly one word: "RESOLVE" if you can answer it ' +
    'directly, "ESCALATE" if it needs a person.',
  tools: [],
};

const triage = agent<World>("support-triage", basicProfile);
// #endregion agent

// #region cases
const cases = [
  example<World>("password-reset", {
    world: () => ({ ticket: "How do I reset my password?" }),
    fixtures: () => ({ models: scriptedPort([[{ type: "text", text: "RESOLVE" }]]), bindings: [] }),
    input: userText("How do I reset my password?"),
  }),
  example<World>("account-hacked", {
    world: () => ({ ticket: "My account was hacked and I need this fixed now." }),
    fixtures: () => ({
      models: scriptedPort([[{ type: "text", text: "ESCALATE" }]]),
      bindings: [],
    }),
    input: userText("My account was hacked and I need this fixed now."),
  }),
  example<World>("business-hours", {
    world: () => ({ ticket: "What are your business hours?" }),
    fixtures: () => ({ models: scriptedPort([[{ type: "text", text: "RESOLVE" }]]), bindings: [] }),
    input: userText("What are your business hours?"),
  }),
];
// #endregion cases

// #region judge
const fakeJudge: Judge = {
  rate: () => Promise.resolve(0.9),
};
// #endregion judge

// #region scorers
const scorers = [
  outputMatches((output) => typeof output === "object" && output !== null),
  llmJudge("polite and on-topic", { minimumScore: 0.7 }, fakeJudge),
];
// #endregion scorers

// scenario() and explore() both call describe() internally, so they're
// registered at suite scope, not inside an it() body.

// #region scenario
scenario("support-triage classifies every ticket", {
  of: triage,
  given: cases,
  runs: 3,
  scorers,
});
// #endregion scenario

// #region explore
explore("support-triage: model and system prompt compared", {
  of: triage,
  variants: grid({
    model: [
      { identifier: "claude-haiku", provider: "test", contextWindow: 100_000, reasoning: [] },
      { identifier: "claude-sonnet", provider: "test", contextWindow: 100_000, reasoning: [] },
    ],
    system: [basicProfile.system, "Reply with RESOLVE or ESCALATE, and nothing else."],
  }), // 2 x 2 = 4 variants
  given: cases, // 3 cases
  runs: 3, // 3 runs per (variant x case)
  scorers,
  rankBy: {
    quality: byScore,
    speed: byTimeToComplete,
    cost: byTokens,
  },
});
// #endregion explore
