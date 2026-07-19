import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters } from "../../index.js";
import { neverCalled, loggedEventTypes } from "./support.js";

// Needs runtime() to append a built-in default ErrorHandler after any
// user-supplied ones — currently errorHandlers defaults to an empty array,
// so an unhandled retryable error rejects immediately. ref: "A default
// handler runs last: it retries retryable errors with exponential backoff
// up to a small cap, otherwise fails."
describe.skip("the built-in default retry/backoff handler, with no errorHandlers configured", () => {
  it("retries a retryable error until the step recovers", async () => {
    let attempts = 0;
    const graph = defineGraph("default-retry-recovers", (flow) => {
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
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const result = await runFlow(graph, userText("go"), ready);

    expect(attempts).toBe(2);
    expect(result).toBe("recovered");
  });

  it("eventually gives up and rejects, logging every retried attempt, when the error never stops recurring", async () => {
    const store = adapters.stores.memoryStore();
    const alwaysRetryable = defineGraph("default-retry-gives-up", (flow) => {
      const step = flow.step((context) =>
        Promise.resolve(context.fail({ type: "timeout", message: "boom", retryable: true })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await expect(runFlow(alwaysRetryable, userText("go"), ready)).rejects.toThrow();

    // more than one "error" entry proves it retried at least once before giving up
    const errorCount = loggedEventTypes(store).filter((type) => type === "error").length;
    expect(errorCount).toBeGreaterThan(1);
  });
});
