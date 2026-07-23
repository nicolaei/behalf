# Steps and emits

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

A step is a node's body; `StepContext` is what it sees; an `Emit` is the one
outcome it returns.

## You will learn

- What `StepContext` exposes: `thread`, `inputs`, `modelCall`, `callTool`
- The difference between reading `context.inputs` and `context.thread.messages`
- The four kinds of `Emit`: `output`, `compact`, `invalidate`, `error`
- How a `PersonaStep` differs from a plain `Step`

## StepContext

_`thread.messages` (assembled view) vs `thread.history` (full record);
`modelCall`/`callTool`. `classifier` here is a `Profile` — introduced next in
Describing a flow; treat it as an opaque named persona for now. Example ref:
`docs/examples/steps-and-emits/two-ways.ts#classify`._

## Reading input two ways

_`context.inputs[0]` (previous node's exact output) vs `context.thread.messages`
(the conversation) — independent, filled differently. Example ref: `#route`._

## The four Emits

_`output` (routed by edges), `compact` (new turn, same thread), `invalidate`
(rerun a node), `error` (hand to the runner, never routed). TODO._

## PersonaStep

_A step that carries its `persona` so coverage sees it with no separate
registration. TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § StepContext, § Step and PersonaStep, § Emit.
**Examples:** `docs/examples/steps-and-emits/two-ways.ts` (reference.md's own "reading input two ways" example) — regions: `classify`, `route`.
**Section:** [Building the graph](./README.md)
**Prev / Next:** [Thinking in behalf](../get-started/thinking-in-behalf.md) / [Wiring a graph](./wiring-a-graph.md)
