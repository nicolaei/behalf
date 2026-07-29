---
"@behalf-js/core": patch
---

Redesign compaction as a data effect instead of a routing `Emit`. `Emit` no
longer carries a `compact` variant — it's routing-only now. Compaction runs
as an awaited effect through `StepContext.compact()`, which has a new
signature, and the on-disk "compaction" event format changed to match.
Replay now correctly folds compaction, invalidation, and bare message
events back into the thread instead of dropping them. `agentTurn`'s fold no
longer force-compacts on every turn — `maybeCompact` decides whether to
compact conditionally instead, based on the thread's actual size.

This is a breaking change to the `Emit` and `StepContext.compact` shapes
and to the persisted event format. It ships as a patch release: the
package is still pre-1.0 and alpha, and nothing external depends on
specific versions yet.
