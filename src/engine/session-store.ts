// Systems running flows / Session store — SessionStore. See docs/reference.md § "SessionStore".

import type { UserMessage } from "../flow/message.js";
import type { ThreadId } from "../flow/thread.js";
import type { Envelope, Event, EventType, Delta } from "../session/index.js";

/**
 * The log, the inbox, and the delta stream. `submit` adds an input to the
 * inbox; `consume` finds and removes a pending message in one call — how
 * the engine drains the inbox at a `waitFor` node; `append` commits an
 * event; `open` begins a streaming event that broadcasts deltas and commits
 * (or aborts) at the end; `changes` yields envelopes of every form.
 */
export interface SessionStore {
  events(): Envelope[]; // committed envelopes
  inbox(): UserMessage[]; // pending input, not yet applied
  submit(message: UserMessage): void;
  consume(matches: (message: UserMessage) => boolean): UserMessage | undefined; // find-and-remove a pending message in one call
  append(
    event: Event[EventType],
    meta: { type: EventType; stepId?: string; stepName?: string; threadId?: ThreadId },
  ): void;
  open(pending: {
    correlationId: string;
    type: EventType;
    stepId: string;
    stepName?: string;
    threadId: ThreadId;
  }): Stream;
  changes(): AsyncIterable<Envelope>;
}

export interface Stream {
  delta(part: Delta): void; // broadcast partial content — not persisted
  commit(event: Event[EventType]): void; // finalize into the log
  abort(): void; // commit what streamed, mark the envelope aborted
}
