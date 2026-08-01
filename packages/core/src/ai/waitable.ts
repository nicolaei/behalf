// The ai extension's two built-in Waitable constructors — physically
// relocated out of graph/waitable.ts (B2.7). `requireInboxKind`/`inboxKindOf`
// (the engine-internal bridge to the pending inbox) stay in graph/waitable.ts:
// they only read the neutral `inboxKind` field this file's `userInput()` sets,
// no message-shaped data, so they don't need to move with these two.

// Side-effect import: registers ai/event.ts's declaration-merge augmentation
// of the core Event registry, so this file's `envelope.type !== "message"`/
// `"toolResult"` comparisons type-check even when compiled in isolation.
import "./event.js";
import type { Envelope, Waitable } from "@behalf-js/engine";
import type { MessageKind, UserMessage } from "./message.js";

/**
 * The built-in Waitable: parks until a message of the given kind arrives. Declares its
 * `inboxKind`, which is what actually opts it into the engine's pending-inbox waiting — the
 * engine used to recognize this waitable by its `provider` name instead, which put ai's own
 * vocabulary inside generic engine dispatch (B3.2).
 * @public
 */
export function userInput(kind: MessageKind): Waitable<UserMessage> {
  return {
    provider: "userInput",
    label: kind,
    inboxKind: kind,
    match: (events: readonly Envelope[]) => {
      for (const envelope of events) {
        if (envelope.form !== "committed" || envelope.type !== "message") continue;
        const message = (envelope.event as { message: UserMessage }).message;
        if (message.kind === kind) return message;
      }
      return undefined;
    },
  };
}

/**
 * A Waitable matching a committed `toolResult` event by correlationId — the
 * decoupled counterpart to a model-call step's own `toolCall` request:
 * whatever eventually resolves the call (the tool executor) commits a
 * `toolResult` event independently, and this Waitable scans the committed log
 * for the one whose correlationId matches.
 * @public
 */
export function toolCall(correlationId: string): Waitable<unknown> {
  return {
    provider: "toolCall",
    label: correlationId,
    match: (events: readonly Envelope[]) => {
      for (const envelope of events) {
        if (envelope.form !== "committed" || envelope.type !== "toolResult") continue;
        const event = envelope.event as { correlationId: string; output: unknown };
        if (event.correlationId === correlationId) return event.output;
      }
      return undefined;
    },
  };
}
