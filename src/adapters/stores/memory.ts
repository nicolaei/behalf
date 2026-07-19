// Adapter — an in-memory SessionStore. For tests and local dev, not production.

import type { SessionStore, Stream } from "../../engine/session-store.js";
import type { UserMessage, Message } from "../../flow/message.js";
import type { Envelope, Event, EventType, SessionId, Delta } from "../../session/index.js";
import type { ThreadId } from "../../flow/thread.js";

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

export function memoryStore(): SessionStore {
  const log: Envelope[] = [];
  const pending: UserMessage[] = [];
  const subscribers = new Set<AsyncQueue<Envelope>>();
  let sequence = 0;

  function broadcast(envelope: Envelope): void {
    for (const subscriber of subscribers) subscriber.push(envelope);
  }

  return {
    events(): Envelope[] {
      return [...log];
    },

    inbox(): UserMessage[] {
      return [...pending];
    },

    submit(message: UserMessage): void {
      pending.push(message);
    },

    consume(matches: (message: UserMessage) => boolean): UserMessage | undefined {
      const index = pending.findIndex(matches);
      if (index === -1) return undefined;
      return pending.splice(index, 1)[0];
    },

    append(
      event: Event[EventType],
      meta: { type: EventType; stepId?: string; stepName?: string; threadId?: ThreadId },
    ): void {
      sequence += 1;
      const envelope = {
        form: "committed",
        sessionId: "" as SessionId,
        threadId: meta.threadId,
        stepId: meta.stepId,
        stepName: meta.stepName,
        type: meta.type,
        event,
        sequence,
        at: Date.now(),
      } as Envelope;
      log.push(envelope);
      broadcast(envelope);
    },

    open(meta: {
      correlationId: string;
      type: EventType;
      stepId: string;
      stepName?: string;
      threadId: ThreadId;
    }): Stream {
      const deltas: Delta[] = [];

      function commit(event: Event[EventType], aborted?: boolean): void {
        sequence += 1;
        const envelope = {
          form: "committed",
          sessionId: "" as SessionId,
          threadId: meta.threadId,
          stepId: meta.stepId,
          stepName: meta.stepName,
          type: meta.type,
          event,
          sequence,
          at: Date.now(),
          ...(aborted ? { aborted: true } : {}),
        } as Envelope;
        log.push(envelope);
        broadcast(envelope);
      }

      return {
        delta(part: Delta): void {
          deltas.push(part); // accumulated for `abort`, never persisted themselves
          broadcast({
            form: "delta",
            sessionId: "" as SessionId,
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
