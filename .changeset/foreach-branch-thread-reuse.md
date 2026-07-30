---
"@behalf-js/core": patch
---

Fixed `tick()`'s forEach handling reusing a stale branch thread id when the
same forEach node is re-entered on a later pass through a loop (the shape
`agentTurn` uses for every turn that calls tools). `forEachBranchThreadId`
derived a branch's thread id from only the forEach node's own stable id and
the item's index — both constant across every replay, but NOT across a
later invocation of the same static node on the same thread. A second pass
through the loop's branch 0 got the identical thread id the first pass's
branch 0 already used, so `replayForEachBranch` walked into the first
pass's already-completed, committed output instead of running the second
pass's own tool wait — leaving the second pass's own `tool_use` blocks with
no matching `tool_result` in the assembled message history (Anthropic's
"unexpected tool_use_id" 400, reproduced live via `behalf-runner`).

`buildForEachGroup` now folds in how many times this forEach node has
already fully completed on this thread — reconstructed purely from the
committed log (one "output" event per completed pass, tagged with the
node's own stepId and thread), the same log-only reconstruction discipline
`replayStateTracker` already uses — so every pass through a re-entered
forEach node gets its own, non-colliding set of branch thread ids.
