import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, RetryableError } from "../../index.js";
import type { ErrorHandler, ModelCallResult, ModelPort, Profile } from "../../index.js";
import { loggedEnvelopes } from "./support.js";

// A model port's own thrown error carries no `retryable` hint by itself —
// only the raiser (e.g. a ModelPort catching a real Anthropic 429) actually
// knows its wire shape. Rather than every graph author hand-rolling a
// try/catch around context.modelCall to build that hint (examples/simple-
// chat's old modelStep), the port throws a RetryableError, and runStep's
// generic catch reads it via instanceof instead of hardcoding
// `retryable: false` for every throw — no step-level try/catch needed
// anywhere.
function flakyPort(): { port: ModelPort; calls: () => number } {
  let calls = 0;
  const port: ModelPort = {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          new RetryableError("rate limited", { retryable: true, cause: { status: 429 } }),
        );
      }
      return Promise.resolve({
        role: "assistant",
        provider: "test",
        model: "scripted",
        content: [{ type: "text", text: "done" }],
        usage: { input: 1, output: 1 },
      });
    },
  };
  return { port, calls: () => calls };
}

function modelCallGraph(profile: Profile) {
  return defineGraph("model-call-classified", (flow) => {
    // No try/catch — the whole point is this shouldn't need one.
    const step = flow.step(async (context) => context.output(await context.modelCall(profile)));
    flow.entry(step);
    step.then(flow.finish);
  });
}

describe("a thrown RetryableError carries its own retryability", () => {
  it("retries with no step-level try/catch", async () => {
    const { port, calls } = flakyPort();
    const profile: Profile = { model: port.model, system: "agent", tools: [] };
    const retryOnce: ErrorHandler = (error, ctx) =>
      error.retryable && ctx.attempts < 1 ? { action: "retry" } : { action: "fail" };

    const ready = await runtime({
      models: () => port,
      bindings: [],
      store: adapters.stores.memoryStore(),
      errorHandlers: [retryOnce],
    });

    const result = await runFlow(modelCallGraph(profile), userText("go"), ready);

    expect(calls()).toBe(2);
    expect((result as ModelCallResult).usedTools).toBe(false);
  });

  it("logs the failed attempt as retryable true — the raiser's own classification, not a hardcoded false", async () => {
    const { port } = flakyPort();
    const profile: Profile = { model: port.model, system: "agent", tools: [] };
    const alwaysRetry: ErrorHandler = () => ({ action: "retry" });
    const store = adapters.stores.memoryStore();

    const ready = await runtime({
      models: () => port,
      bindings: [],
      store,
      errorHandlers: [alwaysRetry],
    });

    await runFlow(modelCallGraph(profile), userText("go"), ready);

    const errorEnvelope = loggedEnvelopes(store).find((e) => e.type === "error");
    expect(errorEnvelope?.event).toMatchObject({ retryable: true });
  });

  it("still defaults to non-retryable for a plain thrown Error", async () => {
    const port: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => Promise.reject(new Error("boom")),
    };
    const profile: Profile = { model: port.model, system: "agent", tools: [] };
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: () => port, bindings: [], store });

    await expect(runFlow(modelCallGraph(profile), userText("go"), ready)).rejects.toThrow();

    const errorEnvelope = loggedEnvelopes(store).find((e) => e.type === "error");
    expect(errorEnvelope?.event).toMatchObject({ retryable: false });
  });
});
