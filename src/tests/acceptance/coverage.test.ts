import { describe, it, expect } from "vitest";
import { defineGraph, satisfiesFlows, tool, provide } from "../../index.js";
import type { Graph, Model, ModelPort, Profile, Tool } from "../../index.js";

describe.skip("satisfiesFlows reports what a runtime is missing", () => {
  function testProfile(): { profile: Profile; search: Tool } {
    const gpt: Model = {
      identifier: "gpt",
      provider: "test",
      contextWindow: 1000,
      reasoning: ["medium"],
    };
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    return {
      profile: { model: gpt, system: "test", tools: [search], reasoning: "medium" },
      search,
    };
  }

  function usesProfileGraph(name: string, profile: Profile): Graph {
    return defineGraph(name, (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flow.entry(respond);
      respond.then(flow.finish);
    });
  }

  function fakePortFor(model: Model): ModelPort {
    return {
      model,
      respond: () =>
        Promise.resolve({
          role: "assistant",
          provider: "test",
          model: model.identifier,
          content: [],
          usage: { input: 0, output: 0 },
        }),
    };
  }

  it("reports nothing missing when the model and tool are both provided", () => {
    const { profile, search } = testProfile();
    const graph = usesProfileGraph("uses-profile", profile);

    const missing = satisfiesFlows([graph], () => fakePortFor(profile.model), [
      provide(search, () => Promise.resolve({ hits: [] })),
    ]);

    expect(missing).toEqual([]);
  });

  it("reports a missing model when the resolver can't provide one", () => {
    const { profile } = testProfile();
    const graph = usesProfileGraph("uses-profile-2", profile);

    const missing = satisfiesFlows([graph], () => undefined, []);

    expect(missing).toContainEqual({ kind: "model", model: profile.model.identifier });
  });
});
