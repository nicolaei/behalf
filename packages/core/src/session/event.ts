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
  compaction: { task?: Message; summary: Message; keepLast: number };
  // `cause: "abort"` marks an invalidation routeAbort (tick.ts) synthesized
  // from a graph-level abort, as opposed to an ordinary context.invalidate()
  // call — replay needs to tell them apart: an ordinary invalidate's target
  // always belongs to the invalidating step's own graph, but an abort's
  // target was captured by a PRIOR process's own graph object (node ids are
  // globally unique per process, not stable across separate constructions
  // of the "same" graph — see freshNodeId), so replay can't trust it and
  // must re-derive the target from its OWN flow.onAbort instead (see
  // applyInvalidationEvent).
  invalidation: { target: NodeId; threadAction: ThreadAction; reason?: Message; cause?: "abort" };
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
