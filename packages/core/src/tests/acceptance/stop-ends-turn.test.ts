// A stop ends the TURN, whatever was live when it landed — and it keeps working
// across runs of the same session. See the design (§3, §4, §11) and the two faults
// a live check against a real session found:
//
// 1. A mid-tool stop killed the command but not the turn: `onAbort` was reachable
//    only through a preempted model call, so a stop that landed while only a tool
//    was in flight let the loop open a fresh model call and write a whole reply.
// 2. Stop worked once per session: the in-memory `stopping` flag was cleared only
//    by a later press that happened to find nothing live.

import { describe, it, expect } from "vitest";
import {
  ai,
  defineGraph,
  driveFlow,
  runtime,
  agentTurn,
  userInput,
  provide,
  tool,
} from "../../index.js";
import type { Profile, ModelPort, SessionStore } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import {
  assistantText,
  assistantToolCall,
  textOf,
  awaitEventType,
  awaitAssistantMessage,
  loggedEnvelopes,
} from "./support.js";

function sendChatPrompt(store: SessionStore, text: string): void {
  store.receive({
    kind: "message",
    message: { role: "user", intent: "standard", kind: "chat", content: [{ type: "text", text }] },
  });
}

/** A settle window long enough for anything a stop might have triggered — a second
 * model call included — to reach the log. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

describe("a stop with only a tool call in flight", () => {
  it("ends the turn: no further model call, the flow parks at onAbort, the toolResult carries the mark", async () => {
    const sleep = tool<{ seconds: number }, { slept: boolean }>("sleep", "Sleep.");
    const model = {
      identifier: "scripted",
      provider: "test",
      contextWindow: 1000,
      reasoning: [],
    } as const;

    let modelCalls = 0;
    let toolStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const port: ModelPort = {
      model,
      respond: (_profile, messages) => {
        modelCalls += 1;
        // The first prompt asks for a tool; anything later is an ordinary reply,
        // so a turn that wrongly continued would be visible as a second call.
        if (modelCalls === 1) return Promise.resolve(assistantToolCall("sleep", { seconds: 100 }));
        return Promise.resolve(assistantText(`reply to ${textOf(messages.at(-1))}`));
      },
    };
    const profile: Profile = { model, system: "test", tools: [sleep] };

    const graph = defineGraph("chat-like", (flow) => {
      const turn = flow.use(agentTurn(profile));
      const waitForPrompt = flow.waitFor(userInput("chat"));
      flow.entry(waitForPrompt);
      turn.then(waitForPrompt);
      waitForPrompt.then(turn);
      flow.onAbort(waitForPrompt);
    });

    const store = memoryStore();
    const ready = await runtime({
      store,
      extensions: [
        ai({
          models: () => port,
          bindings: [
            provide(sleep, (_input, context) => {
              toolStarted();
              // Honours its signal by returning partial work, so the toolResult
              // still commits — the tool dies, and the question is what the turn does.
              return new Promise<{ slept: boolean }>((resolve) => {
                context.signal.addEventListener("abort", () => {
                  resolve({ slept: false });
                });
              });
            }),
          ],
        }),
      ],
    });
    driveFlow(graph, ready).catch(() => undefined);

    sendChatPrompt(store, "sleep please");
    await handlerStarted;

    const resultCommitted = awaitEventType(store, "toolResult");
    ready.abort();
    const toolResult = await resultCommitted;
    await settle();

    // The mark, on the thing the stop interrupted.
    expect(toolResult.aborted).toBe(true);
    // The turn ended: the loop never asked the model to respond again.
    expect(modelCalls).toBe(1);
    // ...and no assistant reply was written after the stop.
    expect(
      loggedEnvelopes(store).filter(
        (envelope) =>
          envelope.type === "message" &&
          (envelope.event as { message: { role: string } }).message.role === "assistant" &&
          (envelope.event as { message: { content: { type: string }[] } }).message.content.some(
            (block) => block.type === "text",
          ),
      ),
    ).toHaveLength(0);

    // The flow reached its onAbort target — it is parked on the next prompt, and
    // answers one normally.
    const replied = awaitAssistantMessage(store);
    sendChatPrompt(store, "second");
    expect(textOf(((await replied).event as { message: { content: [] } }).message)).toBe(
      "reply to second",
    );
  });
});

describe("a second stop, in a later run of the same session", () => {
  it("kills what it should — no idle press in between to un-stick anything", async () => {
    const model = {
      identifier: "scripted",
      provider: "test",
      contextWindow: 1000,
      reasoning: [],
    } as const;

    let resolveStarted: (() => void) | undefined;
    function nextModelCallStart(): Promise<void> {
      return new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
    }

    const port: ModelPort = {
      model,
      respond: (_profile, messages, stream) => {
        const last = textOf(messages.at(-1));
        if (last === "hang") {
          resolveStarted?.();
          return new Promise(() => {
            stream.delta({ correlationId: "1", open: "text" });
            stream.delta({ correlationId: "1", text: "partial" });
          });
        }
        return Promise.resolve(assistantText(`reply to ${last}`));
      },
    };
    const profile: Profile = { model, system: "test", tools: [] };

    const graph = defineGraph("chat-like", (flow) => {
      const turn = flow.use(agentTurn(profile));
      const waitForPrompt = flow.waitFor(userInput("chat"));
      flow.entry(waitForPrompt);
      turn.then(waitForPrompt);
      waitForPrompt.then(turn);
      flow.onAbort(waitForPrompt);
    });

    const store = memoryStore();
    const ready = await runtime({
      store,
      extensions: [ai({ models: () => port, bindings: [] })],
    });
    driveFlow(graph, ready).catch(() => undefined);

    const firstStarted = nextModelCallStart();
    sendChatPrompt(store, "hang");
    await firstStarted;
    const firstAborted = awaitEventType(store, "message");
    ready.abort();
    await firstAborted;
    await settle();

    expect(loggedEnvelopes(store).filter((envelope) => envelope.aborted === true)).toHaveLength(1);

    const secondStarted = nextModelCallStart();
    sendChatPrompt(store, "hang");
    await secondStarted;
    const secondAborted = awaitEventType(store, "message");
    ready.abort();
    await secondAborted;
    await settle();

    expect(loggedEnvelopes(store).filter((envelope) => envelope.aborted === true)).toHaveLength(2);
  });
});
