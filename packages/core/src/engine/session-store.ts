// Systems running flows / Session store — SessionStore. See docs/reference.md § "SessionStore".

import type { UserMessage } from "../flow/message.js";
import type { ThreadId } from "../flow/thread.js";
import type { Envelope, Event, EventType, Stream } from "../session/index.js";

/**
 * A pending, not-yet-committed entry — either a real conversational message or a
 * non-conversational signal a `Waitable` can match on. Arrival order is preserved in
 * one shared queue regardless of kind. @public
 */
export type PendingEntry =
  { kind: "message"; message: UserMessage } | { kind: "signal"; name: string; payload?: unknown };

/**
 * The log, the pending queue, and the delta stream. `receive` adds an entry
 * (a message or a signal) to the pending queue; `consume` finds and removes a
 * pending entry in one call — how the engine drains it at a `waitFor` node;
 * `append` commits an event; `open` begins a streaming event that broadcasts
 * deltas and commits (or aborts) at the end; `changes` yields envelopes of
 * every form; `awaitReceive` resolves once, the next time `receive` adds a
 * fresh pending entry *or* `append` commits a fresh event — a wake-only
 * signal carrying no payload, letting a parked `waitFor`-style loop block on
 * a genuine event instead of polling on a timer, whether it's polling the
 * pending inbox (`consume`) or a `Waitable`'s `match()` against the
 * committed log (`events`). A caller re-checks its own source after it
 * resolves; it makes no promise about which one changed, or that anything
 * matches yet — a wake can be spurious and the caller just goes back to
 * sleep.
 * @public
 */
export interface SessionStore {
  events(): Envelope[]; // committed envelopes
  inbox(): PendingEntry[]; // pending input, not yet applied
  receive(entry: PendingEntry): void;
  awaitReceive(): Promise<void>; // resolves once, on the next receive() call or append() call
  consume(matches: (entry: PendingEntry) => boolean): PendingEntry | undefined; // find-and-remove a pending entry in one call
  append(
    event: Event[EventType],
    meta: { type: EventType; stepId?: string; stepName?: string; threadId?: ThreadId },
  ): void;
  open(meta: {
    correlationId: string;
    type: EventType;
    stepId: string;
    stepName?: string;
    threadId: ThreadId;
  }): Stream;
  changes(): AsyncIterable<Envelope>;
}
