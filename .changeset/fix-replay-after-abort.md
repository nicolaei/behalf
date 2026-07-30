---
"@behalf-js/core": patch
---

Fixed replaying an aborted turn against a fresh process crashing with `replayPosition: invalidation target belongs to no frame`.

Node ids are globally unique per process (`freshNodeId` is a module-level counter, never reset), not
stable across separate constructions of the "same" graph shape — two `chatGraph(profile)` calls in
two different processes assign entirely different numbers to structurally identical nodes.
`applyInvalidationEvent` trusted a logged invalidation's `target` id verbatim, which only ever
holds when replaying within the same process that logged it.
An ordinary `context.invalidate(...)` never crosses that boundary, so its handling is unchanged.
A graph-level abort's invalidation (`routeAbort`) does, by definition, whenever a session resumes in
a new process — so `Event["invalidation"]` gains an optional `cause?: "abort"`, and replay now
re-derives an abort's target the same way `routeAbort` decided it live: walking the position's frame
stack innermost-first for the first frame that declares its own `flow.onAbort`, landing on that
frame's real, current-process node id instead of a foreign one.
