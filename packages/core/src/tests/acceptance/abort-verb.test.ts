// `runtime.abort()` as a verb the runtime answers, rather than a message a caller
// places in the inbox. See the design: "Stop is a verb behalf owns, and it leaves
// marks rather than rows" (§3, §4, §11).
//
// Three narrow claims, each failing for exactly one reason: a press at idle writes
// nothing at all; two presses during one run produce ONE aborted turn (the second
// is a no-op, not a second mark and not a trap armed under the next turn); and a
// toolResult committed after an abort carries the `aborted` mark on its envelope.

import { describe, it, expect } from "vitest";
import {
  ai,
  defineGraph,
  driveFlow,
  runtime,
  agentTurn,
  userInput,
  userText,
  provide,
  tool,
} from "../../index.js";
import type { Profile, ModelPort, Runtime, SessionStore, Envelope } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { runToCompletion } from "@behalf-js/testing";
import {
  assistantText,
  assistantToolCall,
  textOf,
  awaitEventType,
  awaitAssistantMessage,
  loggedEnvelopes,
} from "./support.js";

/** A chat-shaped graph whose model hangs forever on the prompt "hang" and replies
 * normally to anything else — the same shape the onAbort tests use, so an abort has
 * something real to preempt and the run survives to answer a later prompt. */
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
      if (last === "hang") {
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
    runtimeReady: runtime({ store, extensions: [ai({ models: () => port, bindings: [] })] }),
    modelCallStarted,
  };
}

function sendChatPrompt(store: SessionStore, text: string): void {
  store.receive({
    kind: "message",
    message: { role: "user", intent: "standard", kind: "chat", content: [{ type: "text", text }] },
  });
}

/** A settle window long enough for anything an abort might have triggered to reach
 * the log — the point of the idle test is that nothing does. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

describe("runtime.abort() at idle", () => {
  it("writes nothing to the log — entry for entry, the log is what it was", async () => {
    const { graph, store, runtimeReady } = buildHangingChatGraph();
    const ready = await runtimeReady;
    driveFlow(graph, ready).catch(() => undefined);

    const replied = awaitAssistantMessage(store);
    sendChatPrompt(store, "hello");
    await replied;
    await settle(); // let the turn finish landing before snapshotting

    const before: Envelope[] = store.events();

    ready.abort();
    await settle();

    expect(store.events()).toEqual(before);
    expect(store.inbox()).toEqual([]); // and no invisible trap left pending either
  });
});

describe("two aborts during one run", () => {
  it("produce ONE aborted turn — the second press is a no-op, not a second mark", async () => {
    const { graph, store, runtimeReady, modelCallStarted } = buildHangingChatGraph();
    const ready = await runtimeReady;
    driveFlow(graph, ready).catch(() => undefined);

    sendChatPrompt(store, "hang");
    await modelCallStarted;

    const abortedCommit = awaitEventType(store, "message");
    ready.abort();
    ready.abort();
    await abortedCommit;
    await settle();

    expect(loggedEnvelopes(store).filter((envelope) => envelope.aborted === true)).toHaveLength(1);
  });

  it("leave no trap armed under the next turn", async () => {
    const { graph, store, runtimeReady, modelCallStarted } = buildHangingChatGraph();
    const ready = await runtimeReady;
    driveFlow(graph, ready).catch(() => undefined);

    sendChatPrompt(store, "hang");
    await modelCallStarted;

    const abortedCommit = awaitEventType(store, "message");
    ready.abort();
    ready.abort();
    await abortedCommit;

    const secondReply = awaitAssistantMessage(store);
    sendChatPrompt(store, "second");
    expect(textOf(((await secondReply).event as { message: { content: [] } }).message)).toBe(
      "reply to second",
    );
  });
});

describe("a toolResult committed after an abort", () => {
  it("carries `aborted: true` on its envelope", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const model = {
      identifier: "scripted",
      provider: "test",
      contextWindow: 1000,
      reasoning: [],
    } as const;

    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const graph = defineGraph("tool-abort", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall({ model, system: "test", tools: [search] })),
      );
      flow.entry(respond);
      respond.then(flow.finish);
    });

    const store = memoryStore();
    const ready = await runtime({
      store,
      extensions: [
        ai({
          models: () => ({
            model,
            respond: () => Promise.resolve(assistantToolCall("search", { query: "x" })),
          }),
          bindings: [
            provide(search, (_input, context) => {
              started();
              // Honours the signal in its own idiom: returns partial work rather
              // than throwing, so the toolResult still commits.
              return new Promise<{ hits: string[] }>((resolve) => {
                context.signal.addEventListener("abort", () => {
                  resolve({ hits: [] });
                });
              });
            }),
          ],
        }),
      ],
    });

    const run = runToCompletion(graph, userText("go"), ready);
    run.catch(() => undefined); // the run's own fate is another test's claim
    await handlerStarted;

    const resultCommitted = awaitEventType(store, "toolResult");
    ready.abort();
    const envelope = await resultCommitted;

    expect(envelope.aborted).toBe(true);
  });
});
