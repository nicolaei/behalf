// The counterpart to `commitInboxMessage`, and the coupling B3.1 removed.
//
// Replay has to recognize, from the log alone, that a `waitFor` node was
// already satisfied by a consumed inbox entry. Until B3.1 it did that by
// matching the literal event type `"message"` in three places — ai's own
// vocabulary choice, hardcoded inside the engine, and invisible to the import
// scan `engine-is-ai-free.test.ts` runs.
//
// Now the engine asks instead: `EngineExtension.inboxMessageOf` (read) is the
// mirror of `commitInboxMessage` (write). The extension that claims an inbox
// entry decides what event type it becomes, and claims it back later.
//
// This test proves the recognition is genuinely type-agnostic by choosing a
// word the engine has never heard of — `"note"` — and restarting mid-flow, so
// the resumption goes through a cold replay of the log rather than any live
// in-memory position.

import { describe, it, expect } from "vitest";
import {
  defineGraph,
  driveFlow,
  isCommittedEnvelope,
  outputs,
  runtime,
  seed,
} from "@behalf-js/engine";
import type { EngineExtension, Waitable, WaitForResult } from "@behalf-js/engine";
import { memoryStore } from "@behalf-js/stores";

declare module "@behalf-js/engine" {
  interface Event {
    note: { text: string };
  }
}

/**
 * An extension that owns one inbox vocabulary end to end: entries arriving as
 * `{ kind: "jot" }` are committed as its own `"note"` events, and recognized
 * back out of the log as the same messages.
 */
function notes(): EngineExtension {
  return {
    name: "notes",
    commitInboxMessage(message, appendEvent) {
      appendEvent({ text: message.text as string }, "note");
    },
    inboxMessageOf(envelope) {
      if (envelope.type !== "note") return undefined;
      const { text } = envelope.event as { text: string };
      return { kind: "jot", text };
    },
  };
}

/**
 * Parks on an inbox entry of kind `"jot"`. The `userInput` provider name is
 * what the engine's arming path reads to know a `Waitable` waits on a message
 * kind at all (`tryMessageKindOf`) — it names the shape, not the ai package.
 */
function jot(): Waitable<{ text: string }> {
  return { provider: "userInput", label: "jot", match: () => undefined };
}

describe("replay recognizes a consumed inbox entry under any extension's event type", () => {
  it("resumes a waitFor after a restart, from a `note` event the engine has no knowledge of", async () => {
    const flow = defineGraph("notes-flow", (flowBuilder) => {
      const wait = flowBuilder.waitFor(jot());
      const echo = flowBuilder.step(
        outputs((context) => (context.inputs[0] as WaitForResult<{ text: string }>).result.text),
      );
      flowBuilder.entry(wait);
      wait.then(echo);
      echo.then(flowBuilder.finish);
    });

    // One store, two runtimes: the second is a fresh process as far as the
    // engine is concerned, holding no position of its own.
    const store = memoryStore();
    const first = await runtime({ store, extensions: [notes()] });
    seed(flow, undefined, first);
    store.receive({ kind: "message", message: { kind: "jot", text: "remember this" } });
    await driveFlow(flow, first);
    await first.stop();

    const committed = store
      .events()
      .filter(isCommittedEnvelope)
      .map((envelope) => envelope.type);
    expect(committed).toContain("note");
    expect(committed).not.toContain("message");

    const restarted = await runtime({ store, extensions: [notes()] });
    expect(await driveFlow(flow, restarted)).toBe("remember this");
    await restarted.stop();
  });
});
