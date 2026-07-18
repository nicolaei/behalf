import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import type { ErrorHandler } from "../../index.js";
import { neverCalled, loggedEventTypes } from "./support.js";

describe.skip("error handling", () => {
  it("retries a retryable error until it succeeds", async () => {
    // given a step that fails once then succeeds, and a handler that retries once
    let attempts = 0;
    const flaky = defineGraph("flaky", (flow) => {
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
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
      errorHandlers: [retryOnce],
    });

    // when the flow runs
    const result = await runFlow(flaky, userText("go"), ready);

    // then it retried once and finished with the recovered value
    expect(attempts).toBe(2);
    expect(result).toBe("recovered");
  });

  it("appends the error and the recovered output to the session log", async () => {
    // given the same flaky step and retry handler, and a store we can inspect
    let attempts = 0;
    const flaky = defineGraph("flaky-log", (flow) => {
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
    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store,
      errorHandlers: [retryOnce],
    });

    // when the flow runs
    await runFlow(flaky, userText("go"), ready);

    // then the log holds the initial message, the failed attempt, then the recovered output
    expect(loggedEventTypes(store)).toEqual(["message", "error", "output"]);
  });

  it("rejects runFlow when nothing recovers the error", async () => {
    // given a step that always fails, and no error handler
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

    // when the flow runs, then it rejects
    await expect(runFlow(alwaysFails, userText("go"), ready)).rejects.toThrow();
  });
});
