import { describe, it, expect } from "vitest";
import { defineGraph, satisfiesFlows, tool, provide } from "../../index.js";
import type { Graph, Model, ModelPort, Profile, Tool, StepContext } from "../../index.js";

describe("satisfiesFlows reports what a runtime is missing", () => {
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
    const persona = Object.assign(
      async (context: StepContext) => context.output(await context.modelCall(profile)),
      { persona: profile },
    );
    return defineGraph(name, (flow) => {
      const respond = flow.step(persona);
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

// Needs satisfiesFlows to walk the graph's structure statically (finding every
// PersonaStep node) instead of dynamically probing execution — the current
// design only ever sees the first modelCall reachable before the flow's first
// suspension. Written now so the shape is pinned down before that slice starts.
describe("satisfiesFlows discovers persona steps regardless of position in the graph", () => {
  function testProfile(): Profile {
    const gpt: Model = {
      identifier: "gpt",
      provider: "test",
      contextWindow: 1000,
      reasoning: ["medium"],
    };
    return { model: gpt, system: "test", tools: [], reasoning: "medium" };
  }

  it("discovers a persona step that isn't the graph's entry node", () => {
    const profile = testProfile();
    const persona = Object.assign(
      async (context: StepContext) => context.output(await context.modelCall(profile)),
      { persona: profile },
    );

    const graph = defineGraph("persona-step-nested", (flow) => {
      const first = flow.step((context) => Promise.resolve(context.output("go")));
      const second = flow.step(persona);

      flow.entry(first);
      first.then(second);
      second.then(flow.finish);
    });

    // given a resolver missing the model entirely, no execution needed to find it
    const missing = satisfiesFlows([graph], () => undefined, []);

    expect(missing).toContainEqual({ kind: "model", model: "gpt" });
  });

  it("discovers a persona step nested inside a used subgraph", () => {
    const profile = testProfile();
    const persona = Object.assign(
      async (context: StepContext) => context.output(await context.modelCall(profile)),
      { persona: profile },
    );

    const child = defineGraph("persona-child", (flow) => {
      const respond = flow.step(persona);
      flow.entry(respond);
      respond.then(flow.finish);
    });

    const parent = defineGraph("persona-parent", (flow) => {
      const useChild = flow.use(child);
      flow.entry(useChild);
      useChild.then(flow.finish);
    });

    const missing = satisfiesFlows([parent], () => undefined, []);

    expect(missing).toContainEqual({ kind: "model", model: "gpt" });
  });
});
