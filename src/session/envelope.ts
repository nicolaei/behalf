// Session store — Envelope. See docs/reference.md § "Envelope".

import type { ThreadId } from "../flow/thread.js";
import type { Event, EventType } from "./event.js";

/** Opaque brand for session identifiers. @public */
export type SessionId = string & { readonly __brand: "SessionId" };

/**
 * The wrapper around every event on the wire and in the log. `form` says
 * whether it is committed, in-progress (a streaming snapshot), or a live delta.
 * @public
 */
export type Envelope<Type extends EventType = EventType> =
  | {
      form: "committed" | "in-progress";
      sessionId: SessionId;
      threadId?: ThreadId;
      stepId?: string;
      stepName?: string;
      type: Type;
      event: Event[Type];
      sequence: number;
      at: number;
      aborted?: boolean;
    }
  | {
      form: "delta";
      sessionId: SessionId;
      threadId?: ThreadId;
      stepId?: string;
      correlationId: string;
      at: number;
      delta: Delta;
    };

/** A streaming delta fragment pushed before a stream is committed. @public */
export type Delta =
  | { correlationId: string; open: "text" | "thinking" | "toolCall"; name?: string }
  | { correlationId: string; text: string }
  | { correlationId: string; partialInput: string }
  | { correlationId: string; close: true };

/** What a step or tool writes ephemeral progress to. Never persisted, never logged. @public */
export interface DeltaSink {
  delta(part: Delta): void;
}

/** A handle for one streamed event: push partial content, then finalize it into the log. @public */
export interface Stream {
  delta(part: Delta): void; // broadcast partial content — not persisted
  commit(event: Event[EventType]): void; // finalize into the log
  abort(): void; // commit what streamed, mark the envelope aborted
}
