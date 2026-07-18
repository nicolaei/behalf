import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import type { ErrorHandler, Graph, SessionStore } from "../../index.js";
import { neverCalled, loggedEventTypes } from "./support.js";

describe.skip("a step error and its retry handler", () => {
  // A fresh attempt counter per test, and a fresh graph name (defineGraph
  // needs a unique one), so the two `it`s don't share state.
  function flakyFixture(graphName: string): {
    graph: Graph;
    retryOnce: ErrorHandler;
    attempts: () => number;
  } {
    let attempts = 0;
    const graph = defineGraph(graphName, (flow) => {
      const step = flow.step((context) => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? context.fail({ type: "timeout", message: "boom", retryable: true })
            : context.output("recovered"),
        );
      });
      flow.entry(step);
      step.then(flow.finish);
    });
    const retryOnce: ErrorHandler = (error, ctx) =>
      error.retryable && ctx.attempts < 2 ? { action: "retry" } : { action: "fail" };
    return { graph, retryOnce, attempts: () => attempts };
  }

  async function runtimeFor(store: SessionStore, retryOnce: ErrorHandler) {
    return runtime({ models: neverCalled, bindings: [], store, errorHandlers: [retryOnce] });
  }

  it("retries a retryable error until it succeeds", async () => {
    const { graph, retryOnce, attempts } = flakyFixture("flaky");
    const ready = await runtimeFor(adapters.stores.memoryStore(), retryOnce);

    const result = await runFlow(graph, userText("go"), ready);

    expect(attempts()).toBe(2);
    expect(result).toBe("recovered");
  });

  it("appends the failed attempt and the recovered output to the session log", async () => {
    const { graph, retryOnce } = flakyFixture("flaky-log");
    const store = adapters.stores.memoryStore();
    const ready = await runtimeFor(store, retryOnce);

    await runFlow(graph, userText("go"), ready);

    expect(loggedEventTypes(store)).toEqual(["message", "error", "output"]);
  });

  it("rejects runFlow when nothing recovers the error", async () => {
    const alwaysFails = defineGraph("always-fails", (flow) => {
      const step = flow.step((context) =>
        Promise.resolve(context.fail({ type: "validation", message: "nope" })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    await expect(runFlow(alwaysFails, userText("go"), ready)).rejects.toThrow();
  });
});
