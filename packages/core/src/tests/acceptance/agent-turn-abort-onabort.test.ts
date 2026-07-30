// Story 1 of the "graph-level abort" epic: Flow.onAbort / Graph.onAbort, and the
// drive loop routing an aborted step to that declared target instead of failing the
// whole run. See the epic's attached architecture note for the full design.
//
// Split into narrow, single-claim tests on purpose (each should fail for exactly one
// reason): does the run survive at all, does the existing stream-abort commit
// contract still hold, does the run keep doing real work afterward, does a graph that
// never opts in keep today's behavior, and does the lookup bubble out of a use()'d
// subgraph that declares no onAbort of its own.

import { describe, it, expect } from "vitest";
import {
  defineGraph,
  driveFlow,
  runFlow,
  runtime,
  agentTurn,
  userInput,
  userText,
} from "../../index.js";
import type { Profile, ModelPort, Runtime, SessionStore, Event } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import {
  assistantText,
  textOf,
  awaitEventType,
  awaitAssistantMessage,
  loggedEnvelopes,
} from "./support.js";

/**
 * A chatGraph-shaped graph (turn <-> waitForPrompt, flow.onAbort(waitForPrompt))
 * wired to a model port that hangs forever on the prompt "first" and replies
 * normally to anything else. `modelCallStarted` resolves the instant that hanging
 * call has genuinely opened its stream, so a caller can abort it deterministically
 * instead of guessing with a delay.
 */
function buildHangingChatGraph(): {
  graph: ReturnType<typeof defineGraph>;
  store: SessionStore;
  runtimeReady: Promise<Runtime>;
  modelCallStarted: Promise<void>;
} {
  let resolveStarted!: () => void;
  const modelCallStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const port: ModelPort = {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: (_profile, messages, stream) => {
      const last = textOf(messages.at(-1));
      if (last === "first") {
        resolveStarted();
        // Never resolves on its own — only the abort should end this call.
        return new Promise(() => {
          stream.delta({ correlationId: "1", open: "text" });
          stream.delta({ correlationId: "1", text: "partial" });
        });
      }
      return Promise.resolve(assistantText(`reply to ${last}`));
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

describe("agentTurn embedded in a chat-shaped graph with flow.onAbort", () => {
  it("does not reject the run when an in-flight turn is aborted", async () => {
    const { graph, store, runtimeReady, modelCallStarted } = buildHangingChatGraph();
    const ready = await runtimeReady;

    const done = driveFlow(graph, ready); // chatGraph loops forever — never awaited to completion
    sendChatPrompt(store, "first");
    await modelCallStarted;
    sendAbort(store);

    // `done` never resolves either way (the graph loops forever); racing it
    // against a short delay only ever asks "did it reject in time" — the
    // delay winning means no rejection happened within a generous window.
    const outcome = await Promise.race([
      done.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);

    expect(outcome).not.toBe("rejected");
  });

  it("still commits what streamed before the abort, marked aborted", async () => {
    const { graph, store, runtimeReady, modelCallStarted } = buildHangingChatGraph();
    const ready = await runtimeReady;
    driveFlow(graph, ready).catch(() => undefined);

    sendChatPrompt(store, "first");
    await modelCallStarted;

    const abortedCommit = awaitEventType(store, "message"); // subscribe BEFORE triggering
    sendAbort(store);
    await abortedCommit;

    expect(loggedEnvelopes(store).some((e) => e.aborted === true)).toBe(true);
  });

  it("answers a later prompt for real after an abort — the run stayed alive", async () => {
    const { graph, store, runtimeReady, modelCallStarted } = buildHangingChatGraph();
    const ready = await runtimeReady;
    driveFlow(graph, ready).catch(() => undefined);

    sendChatPrompt(store, "first");
    await modelCallStarted;

    const abortedCommit = awaitEventType(store, "message");
    sendAbort(store);
    await abortedCommit;

    const secondReplyCommit = awaitAssistantMessage(store);
    sendChatPrompt(store, "second");
    const secondReply = await secondReplyCommit;

    expect(textOf((secondReply.event as Event["message"]).message)).toBe("reply to second");
  });
});

describe("flow.onAbort backward compatibility", () => {
  it("a graph with no onAbort declared still fails the run on abort (no regression for opt-out callers)", async () => {
    const port: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: (_profile, _messages, stream) =>
        new Promise(() => {
          stream.delta({ correlationId: "1", open: "text" });
          stream.delta({ correlationId: "1", text: "partial" });
        }),
    };
    const profile: Profile = { model: port.model, system: "test", tools: [] };

    const graph = defineGraph("no-onAbort", (flow) => {
      const respond = flow.step(async (context) => context.output(await context.modelCall(profile)));
      flow.entry(respond);
      respond.then(flow.finish);
      // deliberately no flow.onAbort(...)
    });

    const store = memoryStore();
    const ready = await runtime({ models: () => port, bindings: [], store });
    const done = runFlow(graph, userText("hi"), ready);

    sendAbort(store);

    await expect(done).rejects.toThrow("model call aborted");
  });
});

describe("flow.onAbort bubbling through a use()'d subgraph", () => {
  it("bubbles to the nearest enclosing onAbort when the inner subgraph declares none", async () => {
    let resolveStarted!: () => void;
    const modelCallStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const port: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: (_profile, messages, stream) => {
        const last = textOf(messages.at(-1));
        if (last === "go") {
          resolveStarted();
          return new Promise(() => {
            stream.delta({ correlationId: "1", open: "text" });
            stream.delta({ correlationId: "1", text: "partial" });
          });
        }
        return Promise.resolve(assistantText(`reply to ${last}`));
      },
    };
    const profile: Profile = { model: port.model, system: "test", tools: [] };

    // inner: no onAbort of its own.
    const inner = defineGraph("inner", (flow) => {
      const respond = flow.step(async (context) => context.output(await context.modelCall(profile)));
      flow.entry(respond);
      respond.then(flow.finish);
    });

    // outer: use()s inner, declares onAbort back to its own park node.
    const outer = defineGraph("outer", (flow) => {
      const park = flow.waitFor(userInput("go"));
      const turn = flow.use(inner);
      flow.entry(park);
      park.then(turn);
      turn.then(park);
      flow.onAbort(park);
    });

    const store = memoryStore();
    const ready = await runtime({ models: () => port, bindings: [], store });
    driveFlow(outer, ready).catch(() => undefined);

    store.receive({
      kind: "message",
      message: { role: "user", intent: "standard", kind: "go", content: [{ type: "text", text: "go" }] },
    });
    await modelCallStarted;

    const abortedCommit = awaitEventType(store, "message");
    sendAbort(store);
    await abortedCommit;

    const secondReplyCommit = awaitAssistantMessage(store);
    store.receive({
      kind: "message",
      message: { role: "user", intent: "standard", kind: "go", content: [{ type: "text", text: "again" }] },
    });
    const secondReply = await secondReplyCommit;

    expect(textOf((secondReply.event as Event["message"]).message)).toBe("reply to again");
  });
});
