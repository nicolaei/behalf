import { describe, it, expect } from "vitest";
import { ai, defineGraph, runtime, userText, userInput } from "@behalf-js/core";
import type { Envelope, SessionId, SessionStore, UserMessage } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { describeEnvelope, tailCommitted, reconnect, createGateway } from "./tail-the-log.js";
import { runToCompletion } from "@behalf-js/testing";

// These flows park on `userInput`, which is ai vocabulary: the ai extension is
// what commits a consumed inbox message to the log (see
// `EngineExtension.commitInboxMessage`). No model is ever called, so the model
// resolver is one that refuses to be.
function neverCalled(): never {
  throw new Error("no model call expected in this example");
}

// A one-step graph with no stream of its own: a plain turn a client's history
// already holds by the time it reconnects.
const greet = defineGraph("greet", (flow) => {
  const step = flow.step((context) => Promise.resolve(context.output("hi")));
  flow.entry(step);
  step.then(flow.finish);
});

// One SESSION with two turns: a plain first turn, then — after a follow-up
// message arrives — a step that opens its own stream. A reconnecting client
// replays the first turn as history and watches the second arrive live.
//
// Deliberately one graph rather than two runs of different graphs on one
// store: a session's position is reconstructed from its whole log, so two
// independently-driven flows sharing a store would each read the other's
// events as their own.
const session = defineGraph("session", (flow) => {
  const greetStep = flow.step((context) => Promise.resolve(context.output("hi")));
  const followUp = flow.waitFor(userInput("follow-up"));
  const announceStep = flow.step((context) => {
    const stream = context.openStream("output");
    stream.delta({ correlationId: "announce-1", text: "working" });
    stream.commit({ value: "announced" });
    return Promise.resolve(context.output("announced"));
  });
  flow.entry(greetStep);
  greetStep.then(followUp);
  followUp.then(announceStep);
  announceStep.then(flow.finish);
});

/** The follow-up that starts the session's second turn — what a client would submit. */
function followUpMessage(): { kind: "message"; message: UserMessage } {
  return {
    kind: "message",
    message: { role: "user", intent: "standard", kind: "follow-up", content: [] },
  };
}

/** Resolves once the log holds `count` committed envelopes — how a test waits for a turn to settle without racing it. */
async function settledCount(store: SessionStore, count: number): Promise<void> {
  while (store.events().filter((envelope) => envelope.form === "committed").length < count) {
    await store.awaitReceive();
  }
}

describe("Event and Envelope", () => {
  it("carries no type on the event itself; the envelope names it", async () => {
    const store = memoryStore();
    const ready = await runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });
    await runToCompletion(greet, userText("hi"), ready);

    const [message] = store.events();
    expect(message?.form).toBe("committed");
    expect(message && "type" in message ? message.type : undefined).toBe("input");
    expect(message && "event" in message ? message.event : undefined).not.toHaveProperty("type");
    expect(message && describeEnvelope(message)).toMatch(/^committed input:/);
  });
});

describe("tailing the log", () => {
  it("yields only committed envelopes from a real running flow, in order", async () => {
    const store = memoryStore();
    const ready = await runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });

    const seen: Envelope[] = [];
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    void tailCommitted(store, (envelope) => {
      seen.push(envelope);
      if (seen.length === 2) resolveDone?.();
    });

    await Promise.all([done, runToCompletion(greet, userText("hi"), ready)]);

    expect(
      seen.map((envelope) => (envelope.form === "committed" ? envelope.type : undefined)),
    ).toEqual(["input", "output"]);
    expect(seen.every((envelope) => envelope.form === "committed")).toBe(true);
  });
});

describe("reconnecting", () => {
  it("replays the committed log, then streams in-progress, a delta, and new commits live", async () => {
    const store = memoryStore();
    const ready = await runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });

    // Drive the session's first turn and leave it parked at its follow-up
    // wait — the history a reconnecting client needs to catch up on. Kept
    // unawaited on purpose: the run only resolves once the second turn lands.
    const done = runToCompletion(session, userText("hi"), ready);
    await settledCount(store, 2);

    const live: Envelope[] = [];
    let resolveLive: (() => void) | undefined;
    const liveDone = new Promise<void>((resolve) => {
      resolveLive = resolve;
    });
    const replayed = reconnect(store, (envelope) => {
      live.push(envelope);
      if (live.filter((seen) => seen.form === "committed").length === 5) resolveLive?.();
    });

    // The replay is the settled history from the first turn: nothing live yet.
    expect(
      replayed.map((envelope) => (envelope.form === "committed" ? envelope.type : undefined)),
    ).toEqual(["input", "output"]);

    // The session's second turn: submitting the follow-up is what a reconnected
    // client watches arrive live.
    store.receive(followUpMessage());
    await Promise.all([liveDone, done]);

    // the replayed history arrives first, then the second turn's own
    // sequence: the consumed follow-up message, an in-progress stream, one
    // delta, the stream's own commit, and the step's routed final output
    const liveOnly = live.slice(replayed.length);
    expect(liveOnly.map((envelope) => envelope.form)).toEqual([
      "committed",
      "in-progress",
      "delta",
      "committed",
      "committed",
    ]);
    const [messageCommit, inProgress, delta, streamCommit, outputCommit] = liveOnly;
    expect(messageCommit?.form === "committed" && messageCommit.type).toBe("message");
    expect(inProgress?.form === "in-progress" && inProgress.type).toBe("output");
    expect(delta?.form === "delta" && "text" in delta.delta && delta.delta.text).toBe("working");
    expect(streamCommit?.form === "committed" && streamCommit.type).toBe("output");
    expect(outputCommit?.form === "committed" && outputCommit.type).toBe("output");
  });
});

describe("Gateway", () => {
  it("connect replays the log then streams live envelopes; submit puts a message in the inbox", async () => {
    const store = memoryStore();
    const ready = await runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });
    const done = runToCompletion(session, userText("hi"), ready);
    await settledCount(store, 2);

    const sessionId = "session-1" as SessionId;
    const gateway = createGateway(new Map([[sessionId, store]]));

    const sent: string[] = [];
    let resolveLive: (() => void) | undefined;
    const liveDone = new Promise<void>((resolve) => {
      resolveLive = resolve;
    });
    gateway.connect(sessionId, {
      send: (data: string) => {
        sent.push(data);
        if (sent.length === 7) resolveLive?.();
      },
    });

    expect(sent).toHaveLength(2);
    expect((JSON.parse(sent[0] ?? "{}") as { type?: string }).type).toBe("input");

    // The session's second turn: connect's live tail delivers it without a
    // fresh connect() call.
    store.receive(followUpMessage());
    await Promise.all([liveDone, done]);
    const live = sent.slice(2).map((data) => JSON.parse(data) as { form: string });
    expect(live.map((envelope) => envelope.form)).toEqual([
      "committed",
      "in-progress",
      "delta",
      "committed",
      "committed",
    ]);

    gateway.submit(sessionId, {
      role: "user",
      intent: "standard",
      content: [{ type: "text", text: "and add tests" }],
    });

    expect(store.inbox()).toEqual([
      {
        kind: "message",
        message: {
          role: "user",
          intent: "standard",
          content: [{ type: "text", text: "and add tests" }],
        },
      },
    ]);
  });
});
