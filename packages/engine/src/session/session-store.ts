// Systems running flows / Session store — SessionStore. See docs/reference.md § "SessionStore".

import type { ScopeId } from "../graph/thread.js";
import type { Envelope, Event, EventType, Stream } from "./index.js";

/**
 * A message sitting in the inbox, as far as the engine is concerned: something that may
 * carry a `kind`, which is the only property core ever reads (a `waitFor` node matches its
 * armed `Waitable`'s message kind against it). Everything else about a message — role,
 * content, intent — is the vocabulary of whichever extension owns it; ai's `UserMessage`
 * satisfies this structurally, with no declared relationship in either direction.
 *
 * The index signature is load-bearing, not decoration: without it `kind` would be the only
 * declared property and all of it optional, making this a WEAK type — TypeScript then
 * rejects `store.receive({ kind: "message", message: { role, intent, content } })` for
 * having nothing in common with it. Every existing call site passes exactly that shape, so
 * saying "a message carries a `kind` the engine reads, plus whatever else its owner puts
 * there" is both what core actually means and what keeps those call sites compiling.
 * @public
 */
export interface InboxMessage {
  readonly kind?: string;
  readonly [property: string]: unknown;
}

/**
 * A pending, not-yet-committed entry — either a message a `Waitable` can match by kind or a
 * non-conversational signal a `Waitable` can match on. Arrival order is preserved in
 * one shared queue regardless of kind. @public
 */
export type PendingEntry =
  { kind: "message"; message: InboxMessage } | { kind: "signal"; name: string; payload?: unknown };

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
    meta: {
      type: EventType;
      stepId?: string;
      stepName?: string;
      threadId?: ScopeId;
      branchId?: string;
    },
  ): void;
  open(meta: {
    correlationId: string;
    type: EventType;
    stepId: string;
    stepName?: string;
    threadId: ScopeId;
  }): Stream;
  changes(): AsyncIterable<Envelope>;
}
