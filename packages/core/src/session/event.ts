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
  // A non-conversational fact a Waitable can match on — never folded into
  // Thread.messages, unlike `message`. `name` is open like MessageKind, since
  // Waitables are user-extensible and the library can't enumerate every
  // possible external fact an app might define.
  signal: { name: string; payload?: unknown };
  // An application-level phase change, distinct from `stepId`/`stepName`:
  // many nodes may declare the same `state` (see `NodeOptions`), and this
  // fires only when the value actually differs from the last one seen on
  // the thread — never once per node, only once per real transition.
  stateChange: { from?: string; to: string };
}

/** Union of all event type keys. @public */
export type EventType = keyof Event;
