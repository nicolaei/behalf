// Session store — Event. See docs/reference.md § "Event".

// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 5: open Event registry) the `message` event key is an ai-shaped fact riding in core's Event registry; removed when Event opens to extension-registered types and ai adds this key by declaration merging.
import type { Message } from "../ai/message.js";
import type { ThreadAction } from "../graph/thread.js";
import type { NodeId } from "../graph/graph.js";

/** The payload of a durable fact. The envelope names which key applies. @public */
export interface Event {
  message: { message: Message };
  // The durable "here is your starting value" fact — a session's own first
  // event, appended once by `seed()` (runtime.ts). `node` is the flow's entry
  // node; `value` is whatever the caller started the session with (usually a
  // `Message`, but not required to be one — see `replayPosition`, tick.ts,
  // which establishes its starting cursor here instead of assuming an empty
  // log means "start at flow.entry with no input"). A session with no `input`
  // event yet has no starting cursor at all: `tick` just reports it parked.
  input: { node: NodeId; value: unknown };
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
