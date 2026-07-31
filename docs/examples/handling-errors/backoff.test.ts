import { describe, it, expect } from "vitest";
import { defineGraph, runtime, userText } from "@behalf-js/core";
import type { ScopeId } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { noRetryOnValidation, retryFlakyFetchTwice } from "./backoff.js";
import { runToCompletion } from "@behalf-js/testing";

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
      store: memoryStore(),
      errorHandlers: [noRetryOnValidation],
    });

    await expect(runToCompletion(graph, userText("go"), ready)).rejects.toThrow(/bad reply/);
    expect(attempts).toBe(1); // failed on the first attempt, never retried
  });

  it("defers to the next handler once attempts is past its first validation error", () => {
    const context = { step: { id: "s" }, thread: "t" as ScopeId, attempts: 1, log: [] };
    const decision = noRetryOnValidation({ type: "validation", message: "still bad" }, context);
    expect(decision).toBeUndefined(); // only fails fast on the very first attempt
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
      store: memoryStore(),
      errorHandlers: [retryFlakyFetchTwice],
    });

    const result = await runToCompletion(graph, userText("go"), ready);

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
      store: memoryStore(),
      errorHandlers: [retryFlakyFetchTwice],
    });

    await expect(runToCompletion(graph, userText("go"), ready)).rejects.toThrow();
    expect(attempts).toBe(3); // the initial attempt plus two retries, then fail
  });
});
