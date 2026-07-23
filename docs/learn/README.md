# Learn behalf

A guided path through behalf's few concepts and their depth — read in order the first time; come
back to any section on its own after that.
For exact signatures, see [`../reference.md`](../reference.md).

## [Get started](./get-started/README.md)

- [Quick start](./get-started/quick-start.md) — install, define a `Profile` and a graph, run one
  chat turn end to end.
- [Thinking in behalf](./get-started/thinking-in-behalf.md) — the methodology: turns, shape,
  threading, wait points, error handling.

## [Building the graph](./building-the-graph/README.md)

- [Steps and emits](./building-the-graph/steps-and-emits.md) — `Step`, `PersonaStep`, `StepContext`,
  the four `Emit`s.
- [Wiring a graph](./building-the-graph/wiring-a-graph.md) — `defineGraph`, `Flow`, `Handle`, edges
  (`when`/`otherwise`/`then`), fan-out.
- [Threads and forking](./building-the-graph/threads-and-forking.md) — `ThreadId`, `ThreadAction`
  (`same`/`fork`/`new`), `forkedFrom` vs `parentThreadId`.
- [Waiting and interrupts](./building-the-graph/waiting-and-interrupts.md) — `Waitable`, `waitFor`,
  `interrupt`, `userInput`.

## [Describing a flow](./describing-a-flow/README.md)

- [Messages and content](./describing-a-flow/messages-and-content.md) — `Message`, `ContentBlock`,
  thinking blocks, intents.
- [Profiles and models](./describing-a-flow/profiles-and-models.md) — `Profile`, `Model`,
  `ReasoningLevel` — the persona a step calls.
- [Tools and handlers](./describing-a-flow/tools-and-handlers.md) — `tool`/`toolset`, `ToolHandler`,
  `provide`/`expand`, `ToolContext`.

## [Agents in practice](./agents-in-practice/README.md)

- [The agent loop](./agents-in-practice/the-agent-loop.md) — `agentTurn`, budgets, compaction as a
  new turn on the same thread.
- [Fan-out and joining](./agents-in-practice/fan-out-and-joining.md) — parallel branches, `join()`,
  an audit-style example.
- [Handling errors](./agents-in-practice/handling-errors.md) — `StepError`, `ErrorHandler`, retry
  vs. fail, the default backoff handler.

## [Wiring a runtime](./wiring-a-runtime/README.md)

- [Running flows](./wiring-a-runtime/running-flows.md) — `runtime()`, `runFlow()`, the
  `satisfiesFlows` coverage gate.
- [Model ports and bindings](./wiring-a-runtime/model-ports-and-bindings.md) — implementing a
  `ModelPort` for a provider, assembling tool bindings.

## [Testing](./testing/README.md)

- [Testing your flows](./testing/testing-your-flows.md) — `behalf/testing`: `stepOnce`,
  `stepUntilBlocked`, `stepUntil`, `atNode`.
- [Setting up fakes](./testing/setting-up-fakes.md) — `fakePort`, a fake `ModelPort`, and other test
  doubles.
- [Evaluating personas](./testing/evaluating-personas.md) — a vitest-matrix pattern for scoring a
  persona's outputs across cases.

## [Streaming and sessions](./streaming-and-sessions/README.md)

- [Streaming progress](./streaming-and-sessions/streaming-progress.md) — `openStream`, `Stream`,
  deltas, tool-progress cards.
- [Sessions and the gateway](./streaming-and-sessions/sessions-and-the-gateway.md) — `Event`,
  `Envelope`, `SessionStore`, `Gateway` — replay, reconnect, tailing the log.
