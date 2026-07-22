import { describe, it, expect } from "vitest";
import { defineGraph, runtime, adapters, outputs, provide, tool } from "../../../index.js";
import type { ThreadId, ModelPort, Profile, ModelCallResult } from "../../../index.js";
import { neverCalled, assistantText, assistantToolCall } from "../../acceptance/support.js";
import { stepUntilBlocked } from "../../../testing/graph/index.js";

describe("Run folds world, tools, threads, usage on richer graphs", () => {
  it("reflects the fixture's world mutation in its end state", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Searches for a query.");
    const world = { hits: [] as string[] };
    const graph = defineGraph("world-mutation", (flow) => {
      const step = flow.step(async (context) =>
        context.output(await context.callTool(search, { query: "x" })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });
    const bindings = [
      provide(search, (input: { query: string }) => {
        world.hits.push(input.query);
        return Promise.resolve({ hits: ["a"] });
      }),
    ];
    const ready = await runtime({
      models: neverCalled,
      bindings,
      store: adapters.stores.memoryStore(),
    });

    const run = await stepUntilBlocked(graph, ready, world);

    expect(run.world.hits).toEqual(["x"]);
  });

  it("pairs toolCall/toolResult into run.tools, in order", async () => {
    // Tool calls are only ever logged when a model requests one (runModelCall
    // + the decoupled tool executor) — a step calling context.callTool directly
    // is documented to skip logging entirely, so this must go through a
    // scripted model, same shape as agent-loop.test.ts's fixture.
    const search = tool<{ query: string }, { hits: string[] }>("search", "Searches for a query.");
    let calls = 0;
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? assistantToolCall("search", { query: "x" }) : assistantText("done"),
        );
      },
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [search] };
    const graph = defineGraph("tool-pairing", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flow.entry(respond);
      respond
        .when((result) => !(result as ModelCallResult).usedTools, flow.finish)
        .otherwise(respond);
    });
    const bindings = [provide(search, () => Promise.resolve({ hits: ["a"] }))];
    const ready = await runtime({
      models: () => scriptedPort,
      bindings,
      store: adapters.stores.memoryStore(),
    });

    const run = await stepUntilBlocked(graph, ready, {});

    expect(run.tools).toEqual([
      {
        name: "search",
        input: { query: "x" },
        output: { hits: ["a"] },
        thread: expect.any(String) as ThreadId,
      },
    ]);
  });

  it("lists every thread touched, including a forked one", async () => {
    const forkGraph = defineGraph("fork-edge-fold", (flow) => {
      const start = flow.step(outputs((context) => context.thread.id));
      const forked = flow.step(outputs((context) => context.thread.id));
      flow.entry(start);
      start.then(forked, { threadAction: "fork" });
      forked.then(flow.finish);
    });
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const run = await stepUntilBlocked(forkGraph, ready, {});

    expect(run.threads).toHaveLength(2);
  });

  it("sums usage across the run's model calls", async () => {
    const modelCallGraph = defineGraph("model-call-fold", (flow) => {
      const step = flow.step(async (context) => {
        const result = await context.modelCall({
          model: adapters.models.fakePort.model,
          system: "test persona",
          tools: [],
        });
        return context.output(result);
      });
      flow.entry(step);
      step.then(flow.finish);
    });
    const ready = await runtime({
      models: () => adapters.models.fakePort,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const run = await stepUntilBlocked(modelCallGraph, ready, {});

    expect(run.usage.input).toBeGreaterThan(0);
    expect(run.usage.output).toBeGreaterThan(0);
  });
});
