import { describe, it, expect } from "vitest";
import { defineGraph, runtime, runFlow, userText } from "@behalf-js/core";
import type { Envelope, SessionId } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { describeEnvelope, tailCommitted, reconnect, createGateway } from "./tail-the-log.js";

function neverCalled(): never {
  throw new Error("no model call expected in this test");
}

// A one-step graph with no stream of its own: a plain turn a client's history
// already holds by the time it reconnects.
const greet = defineGraph("greet", (flow) => {
  const step = flow.step((context) => Promise.resolve(context.output("hi")));
  flow.entry(step);
  step.then(flow.finish);
});

// A one-step graph that opens its own stream: the live activity a
// reconnecting client sees arrive after the replayed history.
const announce = defineGraph("announce", (flow) => {
  const step = flow.step((context) => {
    const stream = context.openStream("output");
    stream.delta({ correlationId: "announce-1", text: "working" });
    stream.commit({ value: "announced" });
    return Promise.resolve(context.output("announced"));
  });
  flow.entry(step);
  step.then(flow.finish);
});

describe("Event and Envelope", () => {
  it("carries no type on the event itself; the envelope names it", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(greet, userText("hi"), ready);

    const [message] = store.events();
    expect(message?.form).toBe("committed");
    expect(message && "type" in message ? message.type : undefined).toBe("message");
    expect(message && "event" in message ? message.event : undefined).not.toHaveProperty("type");
    expect(message && describeEnvelope(message)).toMatch(/^committed message:/);
  });
});

describe("tailing the log", () => {
  it("yields only committed envelopes from a real running flow, in order", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const seen: Envelope[] = [];
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    void tailCommitted(store, (envelope) => {
      seen.push(envelope);
      if (seen.length === 2) resolveDone?.();
    });

    await Promise.all([done, runFlow(greet, userText("hi"), ready)]);

    expect(
      seen.map((envelope) => (envelope.form === "committed" ? envelope.type : undefined)),
    ).toEqual(["message", "output"]);
    expect(seen.every((envelope) => envelope.form === "committed")).toBe(true);
  });
});

describe("reconnecting", () => {
  it("replays the committed log, then streams in-progress, a delta, and new commits live", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // First turn: history a reconnecting client needs to catch up on.
    await runFlow(greet, userText("hi"), ready);

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
    ).toEqual(["message", "output"]);

    // Second turn, same store: this is what a reconnected client watches arrive live.
    await Promise.all([liveDone, runFlow(announce, userText("go"), ready)]);

    // the replayed history arrives first, then the second turn's own
    // sequence: a committed message, an in-progress stream, one delta, the
    // stream's own commit, and the step's routed final output
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
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(greet, userText("hi"), ready);

    const sessionId = "session-1" as SessionId;
    const gateway = createGateway(new Map([[sessionId, store]]));

    const sent: string[] = [];
    gateway.connect(sessionId, { send: (data: string) => sent.push(data) });

    expect(sent).toHaveLength(2);
    expect((JSON.parse(sent[0] ?? "{}") as { type?: string }).type).toBe("message");

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
