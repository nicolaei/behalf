// Adapter — an in-memory SessionStore. For tests and local dev, not production.

import type { SessionStore, Stream } from "../../engine/session-store.js";
import type { UserMessage, Message } from "../../flow/message.js";
import type { Envelope, Event, EventType, SessionId, Delta } from "../../session/index.js";
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

    open(pending: {
      correlationId: string;
      type: EventType;
      stepId: string;
      stepName?: string;
      threadId: ThreadId;
    }): Stream {
      const deltas: Delta[] = [];

      function commit(event: Event[EventType], aborted?: boolean): void {
        sequence += 1;
        log.push({
          form: "committed",
          sessionId: "" as SessionId,
          threadId: pending.threadId,
          stepId: pending.stepId,
          stepName: pending.stepName,
          type: pending.type,
          event,
          sequence,
          at: Date.now(),
          ...(aborted ? { aborted: true } : {}),
        } as Envelope);
      }

      return {
        delta(part: Delta): void {
          deltas.push(part); // accumulated for `abort`, never persisted themselves
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
      throw new Error("not implemented");
    },
  };
}
