// Flow authoring — Waitable / userInput. See docs/reference.md.

import type { MessageKind, UserMessage } from "./message.js";
import type { Envelope } from "../session/index.js";

/**
 * Describes a condition a `waitFor`/`interrupt` node parks on — a pure
 * function over the committed session log, no IO of its own. `provider`
 * names which kind of thing can satisfy it (checked at boot by
 * `satisfiesFlows` against registered `WaitableSource`s); `label` is a
 * human-readable identity for logs/debugging. The exact matching contract
 * (committed log vs. the pending inbox before consumption) is finalized by
 * the engine wiring, not by this type.
 * @public
 */
export interface Waitable<T> {
  readonly provider: string;
  readonly label: string;
  match(events: readonly Envelope[]): T | undefined;
}

/** The built-in Waitable: parks until a message of the given kind arrives. @public */
export function userInput(kind: MessageKind): Waitable<UserMessage> {
  return {
    provider: "userInput",
    label: kind,
    match: (events) => {
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
 * The message kind a `userInput` Waitable parks on — the engine's bridge to
 * `SessionStore.consume`/`waitForMessage`'s pending-inbox check, which reads
 * one live `UserMessage` at a time rather than replaying committed
 * `Envelope`s the way `match` does. Only meaningful for a `userInput`
 * Waitable today (its `label` is exactly the kind it was built from); a
 * future non-message `Waitable` won't have a message kind at all, so this
 * stays engine-internal rather than part of the public `Waitable` contract —
 * not exported from `flow/index.ts`.
 */
export function messageKindOf(waitable: Waitable<unknown>): MessageKind {
  const kind = tryMessageKindOf(waitable);
  if (kind === undefined)
    throw new Error(`waitable provider "${waitable.provider}" has no message kind`);
  return kind;
}

/**
 * Same as `messageKindOf`, but reports absence instead of throwing — the
 * engine's waitFor/interrupt-arming paths need to tell a `userInput`-shaped
 * `Waitable` apart from any other provider (e.g. a signal-based one) without
 * a try/catch, since only the former ever has a message kind to check the
 * live inbox against.
 */
export function tryMessageKindOf(waitable: Waitable<unknown>): MessageKind | undefined {
  return waitable.provider === "userInput" ? waitable.label : undefined;
}
