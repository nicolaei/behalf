// Adapter — an in-memory SessionStore. For tests and local dev, not production.

import type { SessionStore, PendingEntry } from "../../engine/session-store.js";
import type { Stream } from "../../session/index.js";
import type { Message } from "../../flow/message.js";
import type { Envelope, Event, EventType, SessionId, Delta } from "../../session/index.js";
import type { ThreadId } from "../../flow/thread.js";

// The dev-only store never resolves a real session — every envelope carries this placeholder instead.
const UNSET_SESSION_ID = "" as SessionId;
// A pull-based queue: `push` delivers a value immediately to a waiting `next()`
// caller, or buffers it if nobody is waiting yet. Backs each `changes()`
// subscriber with its own live feed of envelopes.
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: ((value: IteratorResult<T>) => void)[] = [];

  push(value: T): void {
    const next = this.waiting.shift();
    if (next) next({ value, done: false });
    else this.buffered.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          const value = this.buffered.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

/** Builds the envelope committed by both `append` and a `Stream`'s `commit` — the two
 * paths that turn an event into a logged, broadcast envelope, differing only in whether
 * the event was aborted. */
function buildEnvelope(
  meta: { type: EventType; stepId?: string; stepName?: string; threadId?: ThreadId },
  event: Event[EventType],
  sequence: number,
  options?: { aborted?: boolean; form?: "committed" | "in-progress" },
): Envelope {
  return {
    form: options?.form ?? "committed",
    sessionId: UNSET_SESSION_ID,
    threadId: meta.threadId,
    stepId: meta.stepId,
    stepName: meta.stepName,
    type: meta.type,
    event,
    sequence,
    at: Date.now(),
    ...(options?.aborted ? { aborted: true } : {}),
  } as Envelope;
}

/** In-memory SessionStore implementation for tests and local development. @public */
export function memoryStore(): SessionStore {
  const log: Envelope[] = [];
  const pending: PendingEntry[] = [];
  const subscribers = new Set<AsyncQueue<Envelope>>();
  // Wake-only resolvers for `awaitReceive` — parked `pollInbox` loops, one per
  // outstanding call. Registration and the `receive()`/`append()` calls that
  // resolve them are both synchronous, so there's no window where a wake can
  // be missed between a caller's last poll and its subscribe.
  let sequence = 0;
  let receiveWaiters: (() => void)[] = [];

  function broadcast(envelope: Envelope): void {
    for (const subscriber of subscribers) subscriber.push(envelope);
  }

  // Wakes every parked `awaitReceive()` caller. Called by both `receive()`
  // (a fresh pending entry) and `append()` (a fresh committed event) since a
  // parked `pollInbox` loop may be waiting on either — e.g. `waitForSignal`
  // re-checks `Waitable.match()` against the committed log on every wake.
  // Spurious wakes are harmless: the loop just re-polls, finds nothing new,
  // and parks again.
  function wakeReceiveWaiters(): void {
    const waiters = receiveWaiters;
    receiveWaiters = [];
    for (const resolve of waiters) resolve();
  }

  return {
    events(): Envelope[] {
      return [...log];
    },

    inbox(): PendingEntry[] {
      return [...pending];
    },

    receive(entry: PendingEntry): void {
      pending.push(entry);
      wakeReceiveWaiters();
    },

    awaitReceive(): Promise<void> {
      return new Promise((resolve) => receiveWaiters.push(resolve));
    },

    consume(matches: (entry: PendingEntry) => boolean): PendingEntry | undefined {
      const index = pending.findIndex(matches);
      if (index === -1) return undefined;
      return pending.splice(index, 1)[0];
    },

    append(
      event: Event[EventType],
      meta: { type: EventType; stepId?: string; stepName?: string; threadId?: ThreadId },
    ): void {
      sequence += 1;
      const envelope = buildEnvelope(meta, event, sequence);
      log.push(envelope);
      broadcast(envelope);
      wakeReceiveWaiters();
    },

    open(meta: {
      correlationId: string;
      type: EventType;
      stepId: string;
      stepName?: string;
      threadId: ThreadId;
    }): Stream {
      const deltas: Delta[] = [];

      broadcast(buildEnvelope(meta, {} as Event[EventType], sequence, { form: "in-progress" }));

      function commit(event: Event[EventType], aborted?: boolean): void {
        sequence += 1;
        const envelope = buildEnvelope(meta, event, sequence, aborted ? { aborted } : undefined);
        log.push(envelope);
        broadcast(envelope);
      }

      return {
        delta(part: Delta): void {
          deltas.push(part); // accumulated for `abort`, never persisted themselves
          broadcast({
            form: "delta",
            sessionId: UNSET_SESSION_ID,
            threadId: meta.threadId,
            stepId: meta.stepId,
            correlationId: meta.correlationId,
            at: Date.now(),
            delta: part,
          });
        },
        commit,
        abort(): void {
          const text = deltas
            .filter(
              (candidate): candidate is Extract<Delta, { text: string }> => "text" in candidate,
            )
            .map((candidate) => candidate.text)
            .join("");
          const message: Message = {
            role: "assistant",
            content: [{ type: "text", text }],
            provider: "",
            model: "",
            usage: { input: 0, output: 0 },
          };
          commit({ message }, true);
        },
      };
    },

    changes(): AsyncIterable<Envelope> {
      const queue = new AsyncQueue<Envelope>();
      subscribers.add(queue);
      return queue;
    },
  };
}
