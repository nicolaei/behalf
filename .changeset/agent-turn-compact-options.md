---
"@behalf-js/core": patch
---

`agentTurn`'s conditional compaction policy is now overridable via a new
`AgentTurnOptions.compact` (`AgentTurnCompactOptions`): `tokenBudget`,
`keepLast`, and `summarize` were previously hardcoded module-level
constants with no way for a caller to override any of them. `summarize` in
particular was only ever meant to be a temporary stand-in default — a naive
placeholder that states how many messages were folded away, not a real
digest — the intent is for implementors to supply their own real
summarizer (which can now be async, since a real one will likely call a
model). All three fall back to their existing defaults when omitted, so
existing callers see no behavior change.
