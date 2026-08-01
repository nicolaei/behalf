// Session store — Event. See docs/reference.md § "Event".

import type { ScopeAction, ScopeId } from "../graph/thread.js";
import type { NodeId } from "../graph/graph.js";

/**
 * The OPEN event registry. Core ships six execution events — the payload of a durable
 * fact; the envelope names which key applies. Extensions augment it by declaration
 * merging (the ai extension adds message/toolCall/toolResult/compaction — see
 * ai/event.ts). The store itself never enumerates event types: `append`/`events`/`open`
 * are generic over `EventType`/`Event[T]`, so a brand-new extension-registered key needs
 * no core change to flow through them.
 * @public
 */
export interface Event {
  // The durable "here is your starting value" fact — a session's own first
  // event, appended once by `seed()` (runtime.ts). `node` is the flow's entry
  // node; `value` is whatever the caller started the session with (usually a
  // `Message`, but not required to be one — see `replayPosition`, tick.ts,
  // which establishes its starting cursor here instead of assuming an empty
  // log means "start at flow.entry with no input"). A session with no `input`
  // event yet has no starting cursor at all: `tick` just reports it parked.
  input: { node: NodeId; value: unknown };
  output: { value: unknown };
  // A non-conversational fact a Waitable can match on — never folded into
  // any extension's own scope state, unlike `message`. `name` is open like
  // MessageKind, since Waitables are user-extensible and the library can't
  // enumerate every possible external fact an app might define.
  signal: { name: string; payload?: unknown };
  // An application-level phase change, distinct from `stepId`/`stepName`:
  // many nodes may declare the same `state` (see `NodeOptions`), and this
  // fires only when the value actually differs from the last one seen on
  // the scope.
  stateChange: { from?: string; to: string };
  // Rewinds to `target`, on the branch `action` decides (core's own minimal,
  // ai-neutral scope-lifecycle primitive — `"same"` by default, when omitted;
  // old stored data written before `action` existed reads exactly as `"same"`
  // too, so it keeps resuming). `payload` is a generic extension slot — ai
  // rides its own reason/message shape there to seed whatever scope results;
  // core never interprets it, only extensions that register a hook for it do
  // (see `EngineExtension.seedScope`). `cause: "abort"` marks an invalidation
  // routeAbort (tick.ts) synthesized from a graph-level abort, as opposed to
  // an ordinary context.invalidate() call — replay needs to tell them apart:
  // an ordinary invalidate's target always belongs to the invalidating step's
  // own graph, but an abort's target was captured by a PRIOR process's own
  // graph object (node ids are globally unique per process, not stable across
  // separate constructions of the "same" graph — see freshNodeId), so replay
  // can't trust it and must re-derive the target from its OWN flow.onAbort
  // instead (see applyInvalidationEvent).
  //
  // The envelope's own `threadId` is the scope the rerun CONTINUES on — the
  // freshly minted one when `action` is `"fork"`/`"new"`, so replay resyncs to
  // it from the envelope alone and a payload-less fork isn't silently lost.
  // `from` records the scope that was invalidated, which `threadId` used to
  // carry.
  invalidation: {
    target: NodeId;
    action?: ScopeAction;
    from?: ScopeId;
    payload?: unknown;
    cause?: "abort";
  };
  error: { type: string; message: string; retryable?: boolean; cause?: unknown };
}

/** Union of all event type keys. @public */
export type EventType = keyof Event;
