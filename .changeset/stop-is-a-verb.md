---
"@behalf-js/core": patch
---

Make stopping a run a verb the runtime answers, and give every tool a signal to honour.

`ToolContext` gains a `readonly signal: AbortSignal`. `executeToolCall` owns an `AbortController`
per dispatch and clears it in a `finally`, so a handler can honour cancellation in its own idiom
without the executor having to survive one that ignores it. `ToolHandler`'s own type is unchanged —
the context carries the capability.

`runtime.abort()` is the verb.
With no run in flight it returns, having written nothing, nowhere.
With a run in flight it cancels every live tool controller, preempts the model call if one is in
flight, and ends the turn rather than only the round — so a stop that lands mid-tool does not let
the agent start a fresh model call and answer anyway.
A caller no longer has to place a message in an inbox and hope it is consumed at the right moment,
which is what made surplus presses accumulate as landmines under later turns.

The stop leaves marks rather than an entry of its own: the assistant envelope and the `toolResult`
envelope carry `aborted: true`, and the tool's own output carries the fact inline so the model
cannot mistake a half-finished command for a finished one.

A stop also works more than once per session: the in-flight flag is cleared when a run ends, so the
second press stops the second run.
