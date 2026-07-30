// Root cause: node ids come from a process-global counter that's never
// reset (see node-id-determinism.test.ts) — a use()-embedded subgraph's
// completion is only ever recognized by matching a logged step id against
// the current process's own graph. Cross a process boundary (a container
// restart reattaching to a durable store) and every one of those ids is
// foreign; applyOutputEvent's answer is to shrug and skip it as "inner
// noise" rather than crash. That's fine for noise, but a subgraph's own
// exit event is not noise — skip it, and replay never climbs back out of
// agentTurn, no matter how many real turns happened afterward live.
//
// This reproduces the exact live symptom: after a completed multi-turn
// conversation is replayed in a fresh process, the position is stuck
// pointing at a real step node (not a park point) — so the engine fires a
// phantom model call, unprompted, with stale seed data, the instant that
// fresh process starts driving. Confirmed live against a real container
// restart before writing this.

import { describe, it, expect } from "vitest";
import { defineGraph, driveFlow, runtime, agentTurn, userInput } from "../../index.js";
import type { Profile, ModelPort, SessionStore } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { assistantText, awaitAssistantMessage } from "./support.js";

function chatLikeGraph(profile: Profile) {
  return defineGraph("chat-like", (flow) => {
    const turn = flow.use(agentTurn(profile));
    const waitForPrompt = flow.waitFor(userInput("chat"));
    flow.entry(waitForPrompt);
    turn.then(waitForPrompt);
    waitForPrompt.then(turn);
    flow.onAbort(waitForPrompt);
  });
}

/** Replies normally to every prompt — no hanging, no abort. Plain,
 * ordinary turn completion is the whole point of this file. `label`
 * distinguishes which port instance actually answered, the same way
 * replay-after-abort.test.ts's hangingPort does — memoryStore()/driveFlow()
 * have no "stop" API, so an original process's own background loop is
 * still polling the same store throughout a test simulating its
 * replacement. The labels make a wrong answerer visible in a failure
 * message; they can't make the second test assert on one (see its own
 * comment on the consume race). */
function repliesNormallyPort(label: string): ModelPort {
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: (_profile, messages) => {
      const last = messages.at(-1);
      const text = last?.role === "user" && last.content[0]?.type === "text" ? last.content[0].text : undefined;
      return Promise.resolve(assistantText(`${label}: reply to ${text}`));
    },
  };
}

function sendChatPrompt(store: SessionStore, text: string): void {
  store.receive({
    kind: "message",
    message: { role: "user", intent: "standard", kind: "chat", content: [{ type: "text", text }] },
  });
}

describe("a multi-turn conversation, replayed fresh after a simulated restart", () => {
  it("does not fire a phantom model call before any new prompt is sent", async () => {
    const profile: Profile = { model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] }, system: "test", tools: [] };
    const store = memoryStore();
    const runtime1 = await runtime({ models: () => repliesNormallyPort("stale"), bindings: [], store });
    const graph1 = chatLikeGraph(profile);
    driveFlow(graph1, runtime1).catch(() => undefined);

    // Two full, completed turns — enough to genuinely enter and exit
    // agentTurn's subgraph at least once, live, in the original process.
    sendChatPrompt(store, "first");
    await awaitAssistantMessage(store);
    sendChatPrompt(store, "second");
    await awaitAssistantMessage(store);

    // Simulated restart: a brand-new runtime/graph pair against the same
    // store, exactly what SessionRegistry.reattachAll does.
    let calledDuringReplay = false;
    const trackingPort: ModelPort = {
      ...repliesNormallyPort("fresh"),
      respond: (profile2, messages, stream) => {
        calledDuringReplay = true;
        return repliesNormallyPort("fresh").respond(profile2, messages, stream);
      },
    };
    const runtime2 = await runtime({ models: () => trackingPort, bindings: [], store });
    const graph2 = chatLikeGraph(profile);
    driveFlow(graph2, runtime2).catch(() => undefined);

    // Give replay + any continued driving a real window to settle, with
    // nothing new ever sent.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calledDuringReplay).toBe(false);
  });

  it("still answers a real third prompt correctly after the restart", async () => {
    const profile: Profile = { model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] }, system: "test", tools: [] };
    const store = memoryStore();
    const runtime1 = await runtime({ models: () => repliesNormallyPort("stale"), bindings: [], store });
    const graph1 = chatLikeGraph(profile);
    driveFlow(graph1, runtime1).catch(() => undefined);

    sendChatPrompt(store, "first");
    await awaitAssistantMessage(store);
    sendChatPrompt(store, "second");
    await awaitAssistantMessage(store);

    const runtime2 = await runtime({ models: () => repliesNormallyPort("fresh"), bindings: [], store });
    const graph2 = chatLikeGraph(profile);
    driveFlow(graph2, runtime2).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const reply = awaitAssistantMessage(store);
    sendChatPrompt(store, "third");
    // Label-agnostic on purpose, same as replay-after-abort.test.ts's own
    // second case: memoryStore's inbox consume() is destructive and the
    // stale loop (subscribed first, re-registered first on every wake)
    // deterministically wins the race to consume "third" — so this can't
    // attribute the reply to graph2 specifically, only that reattaching
    // doesn't leave the session stuck with nothing able to answer at all.
    // Attributing correct resumption to the fresh instance is the first
    // test's job: a phantom call is exactly what a stuck fresh loop
    // produced before the fix, and it directly proves none fires.
    expect((await reply).event).toMatchObject({ message: { content: [{ text: /reply to third$/ }] } });
  });
});
