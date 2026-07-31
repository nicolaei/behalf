// Proves runModelCall's abort actually reaches the model port's own transport,
// not just the flow: `respond`'s optional `signal` (packages/core/src/engine/
// model-port.ts) fires the instant an abort wins the race in runModelCall
// (engine/runtime/execution.ts). A cooperative port that checks it stops
// emitting real work; this doesn't touch anything Anthropic-specific — the
// port here is a plain, hand-rolled test double, same as any other provider
// would be.
//
// The graph-level abort routing this relies on (flow.onAbort) is Story 1's
// own concern, already covered by agent-turn-abort-onabort.test.ts — this
// file is deliberately narrower: does the signal itself propagate.

import { describe, it, expect } from "vitest";
import { defineGraph, driveFlow, runtime, agentTurn, userInput } from "../../index.js";
import type { Profile, ModelPort, Runtime, SessionStore } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { assistantText, awaitAssistantMessage } from "./support.js";

/**
 * A chatGraph-shaped graph wired to a port that, on the prompt "first",
 * starts a tick loop emitting a delta every 5ms — cooperatively checking
 * `signal.aborted` at the top of each tick, exactly as a real fetch/SDK-
 * backed port would check before making its next request. Never resolves on
 * its own; only an abort (or the test ending) stops it.
 */
function buildCancellableChatGraph(): {
  graph: ReturnType<typeof defineGraph>;
  store: SessionStore;
  runtimeReady: Promise<Runtime>;
  modelCallStarted: Promise<void>;
  deltaCount: () => number;
} {
  let resolveStarted!: () => void;
  const modelCallStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let count = 0;

  const port: ModelPort = {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: (_profile, messages, stream, signal) => {
      const last = messages.at(-1);
      const text =
        last?.role === "user" && last.content[0]?.type === "text"
          ? last.content[0].text
          : undefined;
      if (text !== "first") return Promise.resolve(assistantText(`reply to ${String(text)}`));

      resolveStarted();
      return new Promise(() => {
        const tick = () => {
          if (signal?.aborted) return; // cooperative: stop the instant we're told to, schedule nothing further
          count += 1;
          stream.delta({ correlationId: "1", text: "x" });
          setTimeout(tick, 5);
        };
        tick();
      });
    },
  };
  const profile: Profile = { model: port.model, system: "test", tools: [] };

  const graph = defineGraph("chat-like", (flow) => {
    const turn = flow.use(agentTurn(profile));
    const waitForPrompt = flow.waitFor(userInput("chat"));
    flow.entry(waitForPrompt);
    turn.then(waitForPrompt);
    waitForPrompt.then(turn);
    flow.onAbort(waitForPrompt);
  });

  const store = memoryStore();
  return {
    graph,
    store,
    runtimeReady: runtime({ models: () => port, bindings: [], store }),
    modelCallStarted,
    deltaCount: () => count,
  };
}

function sendChatPrompt(store: SessionStore, text: string): void {
  store.receive({
    kind: "message",
    message: { role: "user", intent: "standard", kind: "chat", content: [{ type: "text", text }] },
  });
}

function sendAbort(store: SessionStore): void {
  store.receive({ kind: "message", message: { role: "user", intent: "abort", content: [] } });
}

describe("runModelCall cancels the port's own transport on abort, not just the flow", () => {
  it("a cooperative port stops emitting real work once its signal fires", async () => {
    const { graph, store, runtimeReady, modelCallStarted, deltaCount } =
      buildCancellableChatGraph();
    const ready = await runtimeReady;
    driveFlow(graph, ready).catch(() => undefined);

    sendChatPrompt(store, "first");
    await modelCallStarted;
    // Let a few real ticks land before aborting, so "it stopped" is a claim
    // about a genuinely running loop, not a coincidence of timing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const countBeforeAbort = deltaCount();
    expect(countBeforeAbort).toBeGreaterThan(0);

    const abortedCommit = awaitAssistantMessage(store);
    sendAbort(store);
    await abortedCommit;
    const countAtAbort = deltaCount();

    // A tick already scheduled before the signal fired still runs once more
    // — it just checks signal.aborted and stops there. Give it a window well
    // past that, then confirm ticking truly stopped rather than just paused.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deltaCount()).toBe(countAtAbort);
  });
});
