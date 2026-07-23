# Agents in practice

Patterns built by composing the previous group's primitives: the loop every
agent runs, parallel work, and what happens when a step breaks.

- [The agent loop](./the-agent-loop.md) — `agentTurn`, budgets, compaction as a new turn on the same thread.
- [Fan-out and joining](./fan-out-and-joining.md) — parallel branches, `join()`, an audit-style example.
- [Handling errors](./handling-errors.md) — `StepError`, `ErrorHandler`, retry vs. fail, the default backoff handler.

**Up:** [Learn behalf](../README.md)
