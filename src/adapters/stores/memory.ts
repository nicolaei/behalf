// Adapter — an in-memory SessionStore. For tests and local dev, not production.

import type { SessionStore, Stream } from "../../engine/session-store.js";
import type { UserMessage } from "../../flow/message.js";
import type { Envelope, Event, EventType, SessionId } from "../../session/index.js";
import type { ThreadId } from "../../flow/thread.js";

export function memoryStore(): SessionStore {
  const log: Envelope[] = [];
  const pending: UserMessage[] = [];
  let sequence = 0;

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
      log.push({
        form: "committed",
        sessionId: "" as SessionId,
        threadId: meta.threadId,
        stepId: meta.stepId,
        stepName: meta.stepName,
        type: meta.type,
        event,
        sequence,
        at: Date.now(),
      } as Envelope);
    },

    open(): Stream {
      throw new Error("not implemented");
    },

    changes(): AsyncIterable<Envelope> {
      throw new Error("not implemented");
    },
  };
}
