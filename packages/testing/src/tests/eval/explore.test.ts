import { describe, it, expect } from "vitest";
import { provide, tool, userText } from "@behalf-js/core";
import type { ModelPort, AssistantMessage } from "@behalf-js/core";
import { runExplore, explore } from "../../eval/harness/explore.js";
import { worldMatches, outputMatches } from "../../eval/scorers.js";
import { agent } from "../../eval/subject.js";
import { byScore, byTimeToComplete, byTokens } from "../../eval/harness/rank.js";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

function assistantToolCall(name: string, input: unknown): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "toolCall", correlationId: "1", name, input }],
    usage: { input: 1, output: 1 },
  };
}

const search = tool<{ query: string }, { hits: string[] }>("search", "Searches for a query.");

function goodModel(): ModelPort {
  let calls = 0;
  return {
    model: { identifier: "good", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: () =>
      Promise.resolve(
        calls++ === 0 ? assistantToolCall("search", { query: "x" }) : assistantText("done"),
      ),
  };
}

function badModel(): ModelPort {
  return {
    model: { identifier: "bad", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: () => Promise.resolve(assistantText("done")),
  };
}

interface World {
  hits: string[];
}

describe("runExplore", () => {
  it("ranks variants by score, worse variant sorts last", async () => {
    const tinyAgent = agent<World>("tiny", {
      model: goodModel().model,
      system: "t",
      tools: [search],
    });

    const result = await runExplore({
      of: tinyAgent,
      variants: [{ model: goodModel().model }, { model: badModel().model }],
      runs: 2,
      given: [
        {
          name: "a search",
          world: (): World => ({ hits: [] }),
          fixtures: (w, profile) => ({
            models: profile.model.identifier === "good" ? goodModel() : badModel(),
            bindings: [
              provide(search, (i: { query: string }) => {
                w.hits.push(i.query);
                return Promise.resolve({ hits: ["a"] });
              }),
            ],
          }),
          input: userText("find x"),
        },
      ],
      scorers: [worldMatches((w: World) => w.hits.length === 1)],
      rankBy: byScore,
    });

    expect(result.variants).toHaveLength(2);
    expect(result.rankings.default).toBeDefined();
    expect(result.rankings.default[0]?.profile.model.identifier).toBe("good");
    expect(result.rankings.default[1]?.profile.model.identifier).toBe("bad");
  });

  it("computes Metrics: mean score, mean usage, mean timeToComplete per variant", async () => {
    const tinyAgent = agent<World>("tiny", { model: badModel().model, system: "t", tools: [] });

    const result = await runExplore({
      of: tinyAgent,
      variants: [{ model: badModel().model }],
      runs: 1,
      given: [
        {
          name: "row",
          world: (): World => ({ hits: [] }),
          fixtures: () => ({ models: badModel(), bindings: [] }),
          input: userText("hi"),
        },
      ],
      scorers: [outputMatches(() => true)],
    });

    const [variant] = result.variants;
    expect(variant?.metrics.score).toBe(1);
    expect(variant?.metrics.usage).toBeDefined();
    expect(typeof variant?.metrics.timeToComplete).toBe("number");
  });

  it("rankBy as a named map: produces one sorted ranking per name, all from the SAME execution", async () => {
    let runRowCalls = 0;
    const tinyAgent = agent<World>("tiny", { model: badModel().model, system: "t", tools: [] });

    function trackedModel(id: string): ModelPort {
      return {
        model: { identifier: id, provider: "test", contextWindow: 1000, reasoning: [] },
        respond: () => {
          runRowCalls += 1;
          return Promise.resolve(assistantText("done"));
        },
      };
    }

    const result = await runExplore({
      of: tinyAgent,
      variants: [{ model: trackedModel("a").model }, { model: trackedModel("b").model }],
      runs: 3,
      given: [
        {
          name: "row",
          world: (): World => ({ hits: [] }),
          fixtures: (_w, profile) => ({
            models: trackedModel(profile.model.identifier),
            bindings: [],
          }),
          input: userText("hi"),
        },
      ],
      scorers: [outputMatches(() => true)],
      rankBy: { quality: byScore, speed: byTimeToComplete, tokens: byTokens },
    });

    // 2 variants x 1 row x 3 runs = 6 executions, regardless of 3 named rankers
    expect(runRowCalls).toBe(6);
    expect(Object.keys(result.rankings).sort()).toEqual(["quality", "speed", "tokens"]);
    expect(result.rankings.quality).toHaveLength(2);
    expect(result.rankings.speed).toHaveLength(2);
    expect(result.rankings.tokens).toHaveLength(2);
  });

  it("defaults rankBy to byScore when omitted, under the 'default' key", async () => {
    const tinyAgent = agent<World>("tiny", { model: badModel().model, system: "t", tools: [] });

    const result = await runExplore({
      of: tinyAgent,
      variants: [{ model: badModel().model }],
      given: [
        {
          name: "row",
          world: (): World => ({ hits: [] }),
          fixtures: () => ({ models: badModel(), bindings: [] }),
          input: userText("hi"),
        },
      ],
      scorers: [outputMatches(() => true)],
    });

    expect(Object.keys(result.rankings)).toEqual(["default"]);
  });

  it("never gates: a variant that scores 0 on every scorer still comes back, not thrown", async () => {
    const tinyAgent = agent<World>("tiny", { model: badModel().model, system: "t", tools: [] });

    const result = await runExplore({
      of: tinyAgent,
      variants: [{ model: badModel().model }],
      given: [
        {
          name: "row",
          world: (): World => ({ hits: [] }),
          fixtures: () => ({ models: badModel(), bindings: [] }),
          input: userText("hi"),
        },
      ],
      scorers: [outputMatches(() => false)],
    });

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.metrics.score).toBe(0);
  });
});

describe("explore", () => {
  // explore() is a thin wrapper: describe(name, () => it("ranks", () =>
  // runExplore(spec))). It never asserts and never fails, so — unlike
  // scenario() — there's no failure-path asymmetry to avoid here: any spec
  // is safe to register directly.
  const tinyAgent = agent<World>("tiny", { model: badModel().model, system: "t", tools: [] });

  explore("a variant sweep registered via the public wrapper", {
    of: tinyAgent,
    variants: [{ model: badModel().model }],
    given: [
      {
        name: "row",
        world: (): World => ({ hits: [] }),
        fixtures: () => ({ models: badModel(), bindings: [] }),
        input: userText("hi"),
      },
    ],
    scorers: [outputMatches(() => true)],
  });
});
