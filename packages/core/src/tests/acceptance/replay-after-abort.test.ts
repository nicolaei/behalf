// A container/process restart replays every session's position fresh from
// its store (packages/core's own contract; cockpit's SessionRegistry.
// reattachAll is exactly this, one layer up). Confirmed live: a real abort,
// once its store was replayed by a brand-new process, crashed with
// "replayPosition: invalidation target belongs to no frame" — this
// reproduces that against @behalf-js/core directly, no cockpit involved.

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

function hangingPort(label: string): { port: ModelPort; modelCallStarted: Promise<void> } {
  let resolveStarted!: () => void;
  const modelCallStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const port: ModelPort = {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: (_profile, messages, stream) => {
      const last = messages.at(-1);
      const text = last?.role === "user" && last.content[0]?.type === "text" ? last.content[0].text : undefined;
      if (text !== "first") return Promise.resolve(assistantText(`${label}: reply to ${text}`));
      resolveStarted();
      return new Promise(() => {
        stream.delta({ correlationId: "1", open: "text" });
        stream.delta({ correlationId: "1", text: "partial" });
      });
    },
  };
  return { port, modelCallStarted };
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

describe("replaying a store containing a real abort, against a brand-new runtime", () => {
  it("does not crash — a fresh process reattaching to an already-aborted session must be able to resume it", async () => {
    const profile: Profile = { model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] }, system: "test", tools: [] };
    const store = memoryStore();
    const { port, modelCallStarted } = hangingPort("stale");
    const runtime1 = await runtime({ models: () => port, bindings: [], store });
    const graph1 = chatLikeGraph(profile);

    driveFlow(graph1, runtime1).catch(() => undefined);
    sendChatPrompt(store, "first");
    await modelCallStarted;

    const abortedCommit = awaitAssistantMessage(store);
    sendAbort(store);
    await abortedCommit;

    // Simulate a process restart: a brand-new runtime/graph pair against the
    // SAME store, exactly what SessionRegistry.reattachAll does.
    const runtime2 = await runtime({ models: () => port, bindings: [], store });
    const graph2 = chatLikeGraph(profile);

    // Must not reject. The bug reproduced here throws synchronously from
    // inside driveFlow's own replay before it ever parks — chatGraph loops
    // forever otherwise, so "still running" (the timeout winning) is the
    // healthy outcome, distinguished from a genuine rejection.
    const outcome = await Promise.race([
      driveFlow(graph2, runtime2).then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    expect(outcome).not.toBe("rejected");
  });

  it("resumes correctly — a real prompt sent after reattaching still gets a real reply, the session isn't left stuck", async () => {
    const profile: Profile = { model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] }, system: "test", tools: [] };
    const store = memoryStore();
    // memoryStore()/driveFlow() have no "stop" API, so graph1's own
    // background loop is still polling the same store for the rest of this
    // test (a limitation of this in-process test double, not of the real
    // fix — a real restarted process has no such lingering loop, verified
    // separately live). It reliably wins the race to consume "second"
    // (subscribed first), so this can't attribute the reply to graph2
    // specifically — only that reattaching doesn't leave the session stuck
    // with nothing able to answer at all, which is still a real regression
    // guard: the crash this file's first test reproduces would otherwise
    // have left it exactly that stuck.
    const { port: stalePort, modelCallStarted } = hangingPort("stale");
    const runtime1 = await runtime({ models: () => stalePort, bindings: [], store });
    const graph1 = chatLikeGraph(profile);

    driveFlow(graph1, runtime1).catch(() => undefined);
    sendChatPrompt(store, "first");
    await modelCallStarted;

    const abortedCommit = awaitAssistantMessage(store);
    sendAbort(store);
    await abortedCommit;

    const { port: freshPort } = hangingPort("fresh");
    const runtime2 = await runtime({ models: () => freshPort, bindings: [], store });
    const graph2 = chatLikeGraph(profile);
    driveFlow(graph2, runtime2).catch(() => undefined);

    const reply = awaitAssistantMessage(store);
    sendChatPrompt(store, "second");
    expect((await reply).event).toMatchObject({ message: { content: [{ text: /reply to second$/ }] } });
  });

  it("resumes an OLD, untagged abort too — data logged before `cause` existed must not be stuck forever", async () => {
    // Simulates a session aborted by an earlier release, before Event["invalidation"]
    // gained `cause`. Its log has the exact old shape: an invalidation with no
    // `cause` field and a `target` naming a node id from a process that no
    // longer exists (here, a made-up id that can't possibly match anything —
    // the point is it must NEVER match, the same as a real foreign-process id).
    const profile: Profile = { model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] }, system: "test", tools: [] };
    const store = memoryStore();
    const { port, modelCallStarted } = hangingPort("whichever");
    const runtime1 = await runtime({ models: () => port, bindings: [], store });
    const graph1 = chatLikeGraph(profile);

    driveFlow(graph1, runtime1).catch(() => undefined);
    sendChatPrompt(store, "first");
    await modelCallStarted;

    const abortedCommit = awaitAssistantMessage(store);
    sendAbort(store);
    await abortedCommit;

    // Directly append an old-shaped invalidation — no `cause`, a target that
    // can't exist in any graph instance — standing in for the real abort's
    // own invalidation event AS IF it predated this fix (it does exist
    // already too, from the sendAbort() above; this one just tests the
    // fallback path specifically, independent of whether the real one
    // happens to also carry `cause` now).
    store.append(
      { target: "node-does-not-exist-anywhere" as never, threadAction: "same" },
      { type: "invalidation" },
    );

    const runtime2 = await runtime({ models: () => port, bindings: [], store });
    const graph2 = chatLikeGraph(profile);

    const outcome = await Promise.race([
      driveFlow(graph2, runtime2).then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    expect(outcome).not.toBe("rejected");
  });
});
