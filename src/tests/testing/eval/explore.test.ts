import { describe, it, expect } from "vitest";
import { provide, tool, userText } from "../../../index.js";
import type { ModelPort } from "../../../index.js";
import { assistantToolCall, assistantText } from "../../acceptance/support.js";
import { runExplore } from "../../../testing/eval/harness/explore.js";
import { worldMatches } from "../../../testing/eval/scorers.js";
import { agent } from "../../../testing/eval/subject.js";
import { byScore } from "../../../testing/eval/harness/rank.js";

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

describe("runExplore", () => {
  it("ranks variants by score, worse variant sorts last", async () => {
    const tinyAgent = agent<{ hits: string[] }>("tiny", {
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
          world: (): { hits: string[] } => ({ hits: [] }),
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
      scorers: [worldMatches((w: { hits: string[] }) => w.hits.length === 1)],
      rankBy: byScore,
    });

    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]?.profile.model?.identifier).toBe("good");
    expect(result.variants[1]?.profile.model?.identifier).toBe("bad");
  });
});
