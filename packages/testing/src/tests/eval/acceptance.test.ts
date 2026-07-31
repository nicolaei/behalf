import { describe, it, expect } from "vitest";
import { provide, tool, userText } from "@behalf-js/core";
import type { ModelPort, AssistantMessage } from "@behalf-js/core";
import {
  agent,
  grid,
  outputMatches,
  llmJudge,
  byScore,
  byTimeToComplete,
  byTokens,
  scenario,
} from "../../eval/index.js";
import type { Judge } from "../../eval/index.js";
import { runExplore } from "../../eval/harness/explore.js";

// Reproduces .plans/eval-framework-interface.md's "End-to-end shape of a
// comparison": a 2x2 grid(), three cases, runs: 3, one exact-match scorer
// plus one injected fake Judge, checked under three named rankers in a
// SINGLE explore call (proving one execution pass, not one per ranker) —
// plus one scenario() gating on the same agent.

const search = tool<{ query: string }, { hits: string[] }>("search", "Searches for a query.");

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 2, output: 2 },
  };
}

interface World {
  hits: string[];
}

describe("acceptance: worked example end to end", () => {
  it("a 2x2 grid x 3 cases x 3 runs explore produces three rankings from one execution pass", async () => {
    let executions = 0;

    function modelFor(identifier: string, systemLabel: string): ModelPort {
      return {
        model: { identifier, provider: "test", contextWindow: 1000, reasoning: [] },
        respond: () => {
          executions += 1;
          return Promise.resolve(assistantText(`${systemLabel}:${identifier}:RESOLVE`));
        },
      };
    }

    const support = agent<World>("support-triage", {
      model: { identifier: "claude-haiku", provider: "test", contextWindow: 1000, reasoning: [] },
      system: "terse",
      tools: [],
    });

    const cases = ["ticketA", "ticketB", "ticketC"].map((name) => ({
      name,
      world: (): World => ({ hits: [] }),
      fixtures: (_world: World, profile: { model: { identifier: string }; system: string }) => ({
        models: modelFor(profile.model.identifier, profile.system),
        bindings: [],
      }),
      input: userText(name),
    }));

    const fakeJudge: Judge = { rate: () => Promise.resolve(0.9) };

    const result = await runExplore({
      of: support,
      variants: grid({
        model: [
          { identifier: "claude-haiku", provider: "test", contextWindow: 1000, reasoning: [] },
          { identifier: "claude-sonnet", provider: "test", contextWindow: 1000, reasoning: [] },
        ],
        system: ["terse", "verbose"],
      }), // 2 x 2 = 4 variants
      given: cases, // 3 cases
      runs: 3, // 3 runs per (variant x case)
      scorers: [
        outputMatches((output) => typeof output === "object"),
        llmJudge("polite and on-topic", { minimumScore: 0.7 }, fakeJudge),
      ],
      rankBy: { quality: byScore, speed: byTimeToComplete, cost: byTokens },
    });

    // 4 variants x 3 cases x 3 runs = 36 executions, once — not once per ranker
    expect(executions).toBe(36);
    expect(result.variants).toHaveLength(4);
    expect(Object.keys(result.rankings).sort()).toEqual(["cost", "quality", "speed"]);
    expect(result.rankings.quality).toHaveLength(4);
    expect(result.rankings.speed).toHaveLength(4);
    expect(result.rankings.cost).toHaveLength(4);

    // every ranking is a permutation of the same 4 variants, not independently regenerated
    const profileIdentifiers = (variants: typeof result.variants) =>
      variants.map((v) => v.profile.model?.identifier).sort();
    expect(profileIdentifiers(result.rankings.quality)).toEqual(
      profileIdentifiers(result.variants),
    );
    expect(profileIdentifiers(result.rankings.speed)).toEqual(profileIdentifiers(result.variants));
    expect(profileIdentifiers(result.rankings.cost)).toEqual(profileIdentifiers(result.variants));
  });

  // scenario() calls describe() internally, so it must be registered at
  // suite scope, not inside an it() body (vitest disallows nesting a suite
  // inside a test).
  const gatedAgent = agent<World>("support-triage-gate", {
    model: { identifier: "claude-haiku", provider: "test", contextWindow: 1000, reasoning: [] },
    system: "terse",
    tools: [search],
  });

  const gatedPort: ModelPort = {
    model: gatedAgent.profile.model,
    respond: () => Promise.resolve(assistantText("RESOLVE")),
  };

  scenario("support-triage resolves a simple ticket", {
    of: gatedAgent,
    world: (): World => ({ hits: [] }),
    fixtures: () => ({
      models: gatedPort,
      bindings: [provide(search, () => Promise.resolve({ hits: [] }))],
    }),
    input: userText("How do I reset my password?"),
    scorers: [outputMatches((output) => typeof output === "object")],
  });
});
