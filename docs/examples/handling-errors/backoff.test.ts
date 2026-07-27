import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { noRetryOnValidation, retryFlakyFetchTwice } from "./backoff.js";

function neverCalled(): never {
  throw new Error("no model call expected in this test");
}

describe("noRetryOnValidation", () => {
  it("fails immediately on a validation error, without retrying", async () => {
    let attempts = 0;
    const graph = defineGraph("validation-fails-fast", (flow) => {
      const step = flow.step((context) => {
        attempts += 1;
        return Promise.resolve(context.fail({ type: "validation", message: "bad reply" }));
      });
      flow.entry(step);
      step.then(flow.finish);
    });
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: memoryStore(),
      errorHandlers: [noRetryOnValidation],
    });

    await expect(runFlow(graph, userText("go"), ready)).rejects.toThrow(/bad reply/);
    expect(attempts).toBe(1); // failed on the first attempt, never retried
  });
});

describe("retryFlakyFetchTwice", () => {
  it("retries a flakyFetch error, recovering despite the raiser's retryable: false", async () => {
    let attempts = 0;
    const graph = defineGraph("flaky-fetch-recovers", (flow) => {
      const step = flow.step((context) => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.resolve(
            context.fail({ type: "flakyFetch", message: "timed out", retryable: false }),
          );
        }
        return Promise.resolve(context.output("fetched"));
      });
      flow.entry(step);
      step.then(flow.finish);
    });
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: memoryStore(),
      errorHandlers: [retryFlakyFetchTwice],
    });

    const result = await runFlow(graph, userText("go"), ready);

    expect(attempts).toBe(3); // two retries, despite retryable: false
    expect(result).toBe("fetched");
  });

  it("gives up and rejects once its own two-retry budget is spent", async () => {
    let attempts = 0;
    const graph = defineGraph("flaky-fetch-gives-up", (flow) => {
      const step = flow.step((context) => {
        attempts += 1;
        return Promise.resolve(
          context.fail({ type: "flakyFetch", message: "timed out", retryable: false }),
        );
      });
      flow.entry(step);
      step.then(flow.finish);
    });
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: memoryStore(),
      errorHandlers: [retryFlakyFetchTwice],
    });

    await expect(runFlow(graph, userText("go"), ready)).rejects.toThrow();
    expect(attempts).toBe(3); // the initial attempt plus two retries, then fail
  });
});
