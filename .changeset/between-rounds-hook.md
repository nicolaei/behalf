---
"@behalf-js/core": minor
---

Give `agentTurn` a `betweenRounds` step — a seam between the rounds of one turn.

`agentTurn(profile, { betweenRounds })` runs that step after a tool round has folded and before the
model is asked again, which is the one moment at which a decision can still change what the next
request carries.

Cockpit's use of it is steering: a message the human typed while the agent was working is folded
onto the thread there, so the next model call sees it instead of waiting for the whole turn to end.

Where it sits is the whole of its contract, so it runs on the loopback and only there — a turn that
ends, on a final message or early on a `finishOn` tool call, never reaches it, because there is no
next model call to run it before. Its own `output` is ignored, since it is not a branch; `invalidate`
and `error` behave as they do on any step.

The step is only created when a caller asks for one, so a turn built without the option keeps the
same wiring and the same node ids as before.