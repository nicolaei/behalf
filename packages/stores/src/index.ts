// Adapter — an in-memory SessionStore. For tests and local dev, not production.

import type {
  SessionStore,
  PendingEntry,
  Stream,
  Envelope,
  Event,
  EventType,
  SessionId,
  Delta,
  AppendMeta,
  StreamMeta,
} from "@behalf-js/engine";

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
  meta: AppendMeta,
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
    ...(meta.branchId ? { branchId: meta.branchId } : {}),
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

    append(event: Event[EventType], meta: AppendMeta): void {
      sequence += 1;
      const envelope = buildEnvelope(meta, event, sequence);
      log.push(envelope);
      broadcast(envelope);
      wakeReceiveWaiters();
    },

    open(meta: StreamMeta): Stream {
      const deltas: Delta[] = [];
      // A model port's own async work (a real network stream) isn't
      // cancelled by abort() or commit() — it's raced, not stopped — so it
      // can keep calling delta()/commit() after this stream is already
      // finalized. `settled` makes both a no-op once that's happened,
      // instead of broadcasting stray content past the point the flow
      // already moved on from (the visible symptom: an aborted turn's
      // reply keeps growing after the abort "succeeded").
      let settled = false;

      broadcast(buildEnvelope(meta, {} as Event[EventType], sequence, { form: "in-progress" }));

      function commit(event: Event[EventType], aborted?: boolean): void {
        if (settled) return;
        settled = true;
        sequence += 1;
        const envelope = buildEnvelope(meta, event, sequence, aborted ? { aborted } : undefined);
        log.push(envelope);
        broadcast(envelope);
      }

      return {
        delta(part: Delta): void {
          if (settled) return;
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
          // No text block at all when nothing streamed before the abort —
          // a real provider's API (Anthropic confirmed) rejects an empty
          // text content block outright, which would otherwise poison the
          // very next turn.
          //
          // The shape below is the ai extension's `"message"` payload, and this
          // store deliberately does not import it: `@behalf-js/stores` depends
          // on `@behalf-js/engine` alone (B3.1), and the engine's `Event`
          // registry is open — a store cannot name any extension's entry
          // without dragging that extension back in. It reconstructs a
          // best-effort payload for whatever stream type it was opened with,
          // which for a streaming model reply is exactly this.
          const message = {
            role: "assistant",
            content: text ? [{ type: "text", text }] : [],
            provider: "",
            model: "",
            usage: { input: 0, output: 0 },
          };
          commit({ message } as unknown as Event[EventType], true);
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
