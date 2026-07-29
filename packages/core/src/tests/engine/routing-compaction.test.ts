import { describe, it, expect } from "vitest";
import { withMessage, withCompaction, deriveCompactedMessages } from "../../engine/runtime.js";
import type { Thread } from "../../engine/runtime.js";
import type { Message } from "../../flow/message.js";
import type { ThreadId } from "../../flow/thread.js";

// Direct unit tests against deriveCompactedMessages/withCompaction themselves —
// these two pure functions are the ONE place `thread.messages` gets computed
// on a compaction event, and every other test in this repo only exercises them
// indirectly (compaction.test.ts drives a whole flow; tick-replay-compaction.test.ts
// drives a whole replay). This file pins their behavior in isolation.

const threadId = "routing-compaction-test-thread" as ThreadId;

function userMsg(text: string): Message {
  return { role: "user", intent: "standard", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): Message {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

function systemMsg(text: string): Message {
  return { role: "system", content: [{ type: "text", text }] };
}

function emptyThread(): Thread {
  return { id: threadId, messages: [], history: [] };
}

describe("deriveCompactedMessages / withCompaction", () => {
  it("message-only folding: withMessage just appends to both messages and history", () => {
    const thread = withMessage(withMessage(emptyThread(), userMsg("hi")), assistantMsg("hello"));

    expect(thread.messages).toEqual([userMsg("hi"), assistantMsg("hello")]);
    expect(thread.history).toEqual(thread.messages);
  });

  it("a single compaction: task + summary + keepLast tail, replicating the design doc's worked example", () => {
    // Full history, in order (the doc's own example):
    // 1. "Add authentication to the API"                  (user)
    // 2. "Sure, let me look at the routes"                (assistant)
    // 3. "Here's what I found"                            (user)
    // 4. "Let me dig deeper"                               (assistant)
    // 5. "Found it, here's why"                            (user)
    const history = [
      userMsg("Add authentication to the API"),
      assistantMsg("Sure, let me look at the routes"),
      userMsg("Here's what I found"),
      assistantMsg("Let me dig deeper"),
      userMsg("Found it, here's why"),
    ];
    const task = systemMsg("Add authentication to the API");
    const summary = systemMsg("Explored the routes, found where auth is missing");

    const messages = deriveCompactedMessages(history, { task, summary, keepLast: 2 });

    // [ task, summary, history[3], history[4] ] — last 2 messages before the compaction.
    expect(messages).toEqual([task, summary, history[3], history[4]]);
  });

  it("a single compaction with no task: only summary + kept tail, task is entirely omitted (not null/undefined slot)", () => {
    const history = [userMsg("one"), userMsg("two"), userMsg("three")];
    const summary = systemMsg("summary only");

    const messages = deriveCompactedMessages(history, { summary, keepLast: 1 });

    expect(messages).toEqual([summary, userMsg("three")]);
    expect(messages).toHaveLength(2); // no task slot at all, not `undefined` in position 0
  });

  it("multiple compactions in sequence: each one's history input is the FULL history, never touched by compaction", () => {
    let thread = emptyThread();
    thread = withMessage(thread, userMsg("m1"));
    thread = withMessage(thread, userMsg("m2"));
    thread = withMessage(thread, userMsg("m3"));

    const firstSummary = systemMsg("first summary");
    thread = withCompaction(thread, { summary: firstSummary, keepLast: 1 });

    // history is untouched by the compaction — only messages was reset.
    expect(thread.history).toEqual([userMsg("m1"), userMsg("m2"), userMsg("m3")]);
    expect(thread.messages).toEqual([firstSummary, userMsg("m3")]);

    // Messages after the first compaction still append onto history, not messages.
    thread = withMessage(thread, userMsg("m4"));
    thread = withMessage(thread, userMsg("m5"));

    expect(thread.history).toEqual([
      userMsg("m1"),
      userMsg("m2"),
      userMsg("m3"),
      userMsg("m4"),
      userMsg("m5"),
    ]);

    const secondSummary = systemMsg("second summary");
    thread = withCompaction(thread, { summary: secondSummary, keepLast: 2 });

    // The second compaction's tail is pulled from the FULL history — including
    // m4/m5, which landed after the first compaction — not from the first
    // compaction's already-reset `messages`.
    expect(thread.messages).toEqual([secondSummary, userMsg("m4"), userMsg("m5")]);
    // history is still every "message" event, still untouched by either compaction.
    expect(thread.history).toEqual([
      userMsg("m1"),
      userMsg("m2"),
      userMsg("m3"),
      userMsg("m4"),
      userMsg("m5"),
    ]);
  });

  it("keepLast larger than available history: clamps to whatever's available, does not throw or pad", () => {
    const history = [userMsg("only-one")];
    const summary = systemMsg("summary");

    const messages = deriveCompactedMessages(history, { summary, keepLast: 1000 });

    expect(messages).toEqual([summary, userMsg("only-one")]);
  });

  it("keepLast larger than an EMPTY history: clamps to an empty tail, no throw", () => {
    const summary = systemMsg("summary");

    const messages = deriveCompactedMessages([], { summary, keepLast: 50 });

    expect(messages).toEqual([summary]);
  });

  it("live-vs-replay equivalence: incremental withCompaction application and a from-scratch fold produce identical messages", () => {
    type Step =
      | { kind: "message"; message: Message }
      | { kind: "compaction"; task?: Message; summary: Message; keepLast: number };

    const events: Step[] = [
      { kind: "message", message: userMsg("Add authentication to the API") },
      { kind: "message", message: assistantMsg("Sure, let me look at the routes") },
      { kind: "message", message: userMsg("Here's what I found") },
      {
        kind: "compaction",
        task: systemMsg("Add authentication to the API"),
        summary: systemMsg("Explored the routes, found where auth is missing"),
        keepLast: 1,
      },
      { kind: "message", message: assistantMsg("Let me dig deeper") },
      { kind: "message", message: userMsg("Found it, here's why") },
      { kind: "compaction", summary: systemMsg("Second pass summary"), keepLast: 2 },
      { kind: "message", message: assistantMsg("Wrapping up") },
    ];

    // Live drive: apply each event incrementally, as a running session would.
    function foldOne(thread: Thread, step: Step): Thread {
      if (step.kind === "message") return withMessage(thread, step.message);
      return withCompaction(thread, {
        ...(step.task ? { task: step.task } : {}),
        summary: step.summary,
        keepLast: step.keepLast,
      });
    }

    let live = emptyThread();
    for (const step of events) live = foldOne(live, step);

    // From-scratch replay: fold the whole sequence at once, in one pass, as replay
    // reconstructing from the log alone would.
    const replayed = events.reduce(foldOne, emptyThread());

    expect(replayed.messages).toEqual(live.messages);
    expect(replayed.history).toEqual(live.history);

    // Not a vacuous comparison — pin the actual expected shape too.
    expect(live.history).toHaveLength(6); // every "message" event, uncompacted
    expect(live.messages).toEqual([
      systemMsg("Second pass summary"),
      assistantMsg("Let me dig deeper"),
      userMsg("Found it, here's why"),
      assistantMsg("Wrapping up"),
    ]);
  });
});
