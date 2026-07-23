# Building the graph

Composing steps into a runnable flow — nodes, edges, threads, and the points
where a flow waits on the outside world. A couple of examples here name a
`Profile` (a persona) before that's formally introduced next, in Describing a
flow — treat it as an opaque named persona for now.

- [Steps and emits](./steps-and-emits.md) — `Step`, `PersonaStep`, `StepContext`, the four `Emit`s.
- [Wiring a graph](./wiring-a-graph.md) — `defineGraph`, `Flow`, `Handle`, edges (`when`/`otherwise`/`then`), fan-out.
- [Threads and forking](./threads-and-forking.md) — `ThreadId`, `ThreadAction` (`same`/`fork`/`new`), `forkedFrom` vs `parentThreadId`.
- [Waiting and interrupts](./waiting-and-interrupts.md) — `Waitable`, `waitFor`, `interrupt`, `userInput`.

**Up:** [Learn behalf](../README.md)
