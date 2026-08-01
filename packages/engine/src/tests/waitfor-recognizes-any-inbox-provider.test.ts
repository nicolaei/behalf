// B3.2's counterpart to `replay-recognizes-any-inbox-event-type.test.ts`, one
// level up.
//
// That test proved the engine no longer hardcodes which committed EVENT satisfies
// a `waitFor`. This one proves it no longer hardcodes which WAITABLE belongs to
// inbox-message routing in the first place. Until B3.2 the engine asked
// `waitable.provider === "userInput"` — ai's own name for its own factory — in
// three dispatch sites, so an engine-only extension had to literally name its
// provider `"userInput"` to get inbox-waiting behaviour at all.
//
// A `Waitable` now says so itself, through the neutral `inboxKind` field. The
// flow below parks on a waitable whose provider (`"buzzer"`) the engine has never
// heard of, and whose `match()` never matches anything — so if the pending inbox
// were not consulted for it, nothing could ever satisfy this node.

import { describe, it, expect } from "vitest";
import { defineGraph, driveFlow, outputs, runtime, seed } from "@behalf-js/engine";
import type { EngineExtension, Waitable, WaitForResult } from "@behalf-js/engine";
import { memoryStore } from "@behalf-js/stores";

declare module "@behalf-js/engine" {
  interface Event {
    buzz: { text: string };
  }
}

/** Owns the `"press"` inbox vocabulary: commits consumed entries as its own `"buzz"` events and claims them back out of the log. */
function buzzers(): EngineExtension {
  return {
    name: "buzzers",
    commitInboxMessage(message, appendEvent) {
      appendEvent({ text: message.text as string }, "buzz");
    },
    inboxMessageOf(envelope) {
      if (envelope.type !== "buzz") return undefined;
      const { text } = envelope.event as { text: string };
      return { kind: "press", text };
    },
  };
}

/**
 * Parks on inbox entries of kind `"press"`. `provider` is a word the engine has
 * never seen, and `match()` deliberately never matches — the only thing that can
 * satisfy this node is the pending-inbox path, which `inboxKind` opts it into.
 */
function buzz(): Waitable<{ text: string }> {
  return { provider: "buzzer", label: "buzz", inboxKind: "press", match: () => undefined };
}

describe("waitFor recognizes an inbox wait under any waitable provider", () => {
  it("consumes a pending inbox entry for a provider the engine has never heard of", async () => {
    const flow = defineGraph("buzzer-flow", (flowBuilder) => {
      const wait = flowBuilder.waitFor(buzz());
      const echo = flowBuilder.step(
        outputs((context) => (context.inputs[0] as WaitForResult<{ text: string }>).result.text),
      );
      flowBuilder.entry(wait);
      wait.then(echo);
      echo.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const engine = await runtime({ store, extensions: [buzzers()] });
    seed(flow, undefined, engine);
    store.receive({ kind: "message", message: { kind: "press", text: "ding" } });

    expect(await driveFlow(flow, engine)).toBe("ding");
    await engine.stop();
  });
});
