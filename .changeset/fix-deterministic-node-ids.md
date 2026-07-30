---
"@behalf-js/core": patch
---

Fixed node ids differing across separate builds of the same graph shape — the root cause behind a
multi-turn session getting stuck inside a `use()`d subgraph (and firing a phantom model call) after
a process restart.

`freshNodeId` drew from a single process-global counter that was never reset, so calling the exact
same graph-building function twice — once at session creation, again when a later process reattaches
to the same store — assigned entirely different numbers to structurally identical nodes. Every node
id the first process logged was foreign to the second one's own graph object; `replayPosition`
skipped a subgraph's own completion event as unowned "inner noise" and the reconstructed position
never climbed back out of the descent.

The counter now resets per OUTERMOST `defineGraph()` call: a nested call (a subgraph built inline
from within a builder callback, e.g. `flow.use(agentTurn(profile))`) keeps drawing from the
enclosing build's running count, so ids stay unique across every nesting level of one composed
graph tree — the invariant `replayPosition`'s depth search depends on — while repeated builds of
the same shape now assign identical ids. `Flow.use` additionally reserves a PRE-BUILT subgraph's
ids (advancing the counter past its whole tree) before allocating the `use` node's own id, so
embedding a graph built by its own earlier top-level call can't reintroduce the collision. A
`forEach` branch graph is the one deliberate exception (rebuilt at runtime as its own outermost
build, its ids can coincide with the main graph's): branch progress was already recognized purely
by deterministic per-branch thread ids, and `replayPosition` now excludes branch-thread output
events from its id search by thread id instead of relying on the old accidental id-membership miss.
