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
