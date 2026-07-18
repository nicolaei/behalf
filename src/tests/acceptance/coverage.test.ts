import { describe, it, expect } from "vitest";
import { defineGraph, satisfiesFlows, tool, provide } from "../../index.js";
import type { Model, ModelPort, Profile } from "../../index.js";

describe.skip("coverage: satisfiesFlows", () => {
  it("reports nothing missing when the model and tool are both provided", () => {
    // given a flow whose persona needs a model and a tool
    const gpt: Model = {
      identifier: "gpt",
      provider: "test",
      contextWindow: 1000,
      reasoning: ["medium"],
    };
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const profile: Profile = { model: gpt, system: "test", tools: [search], reasoning: "medium" };
    const graph = defineGraph("uses-profile", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flow.entry(respond);
      respond.then(flow.finish);
    });
    const fakePort: ModelPort = {
      model: gpt,
      respond: () =>
        Promise.resolve({
          role: "assistant",
          provider: "test",
          model: "gpt",
          content: [],
          usage: { input: 0, output: 0 },
        }),
    };

    // when checked against a runtime that provides both
    const missing = satisfiesFlows([graph], () => fakePort, [
      provide(search, () => Promise.resolve({ hits: [] })),
    ]);

    // then nothing is missing
    expect(missing).toEqual([]);
  });

  it("reports a missing model when the resolver can't provide one", () => {
    // given the same kind of flow, but a resolver with nothing to offer
    const gpt: Model = {
      identifier: "gpt",
      provider: "test",
      contextWindow: 1000,
      reasoning: ["medium"],
    };
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const profile: Profile = { model: gpt, system: "test", tools: [search], reasoning: "medium" };
    const graph = defineGraph("uses-profile-2", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flow.entry(respond);
      respond.then(flow.finish);
    });

    // when checked against a runtime with no model and no tool
    const missing = satisfiesFlows([graph], () => undefined, []);

    // then it reports the missing model
    expect(missing).toContainEqual({ kind: "model", model: "gpt" });
  });
});
