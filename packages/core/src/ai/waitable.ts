// The ai extension's two built-in Waitable constructors — physically
// relocated out of graph/waitable.ts (B2.7). `messageKindOf`/`tryMessageKindOf`
// (the engine-internal bridge to the pending inbox) stay in graph/waitable.ts:
// they only ever check a Waitable's own `provider`/`label` strings, no
// message-shaped data, so they don't need to move with these two.

// Side-effect import: registers ai/event.ts's declaration-merge augmentation
// of the core Event registry, so this file's `envelope.type !== "message"`/
// `"toolResult"` comparisons type-check even when compiled in isolation.
import "./event.js";
import type { Waitable } from "../graph/waitable.js";
import type { Envelope } from "../session/index.js";
import type { MessageKind, UserMessage } from "./message.js";

/** The built-in Waitable: parks until a message of the given kind arrives. @public */
export function userInput(kind: MessageKind): Waitable<UserMessage> {
  return {
    provider: "userInput",
    label: kind,
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
