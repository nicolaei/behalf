// Session store — Event. See docs/reference.md § "Event".

import type { Message } from "../flow/message.js";
import type { ThreadAction } from "../flow/thread.js";
import type { NodeId } from "../flow/graph.js";

/** The payload of a durable fact. The envelope names which key applies. @public */
export interface Event {
  message: { message: Message };
  output: { value: unknown };
  toolCall: { correlationId: string; name: string; input: unknown };
  toolResult: { correlationId: string; output: unknown; isError?: boolean };
  compaction: { messages: Message[]; meta?: unknown };
  invalidation: { target: NodeId; threadAction: ThreadAction; reason?: Message };
  error: { type: string; message: string; retryable?: boolean; cause?: unknown };
}

/** Union of all event type keys. @public */
export type EventType = keyof Event;
