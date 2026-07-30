---
"@behalf-js/core": patch
---

Fixed old, already-logged abort data still crashing on replay after the previous fix (`cause: "abort"` on `Event["invalidation"]`).

That fix only helps invalidations logged by a version of the drive loop that sets `cause` — any
session aborted before it shipped has an invalidation event with no `cause` field at all, so it
still falls into the ordinary-invalidate path and still throws `replayPosition: invalidation
target belongs to no frame`.

An ordinary `context.invalidate(...)`'s target always belongs to the invalidating step's own
graph by construction, so a total miss in that path — no frame owns the target at all, not even
the leaf — was never a valid outcome for it to begin with; it's almost certainly a graph-level
abort logged before `cause` existed. `applyInvalidationEvent` now falls back to the same
`flow.onAbort` walk before giving up, so sessions with old, untagged abort data already on disk
resume too, not just ones aborted after the previous fix landed.
