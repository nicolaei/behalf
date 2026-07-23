# Wiring a graph

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

`defineGraph` composes steps into a runnable flow: nodes for work, edges for
control flow.

## You will learn

- The five node kinds: `step`, `use`, `waitFor`, `interrupt`, `finish`
- The three edge kinds: `when`, `otherwise`, `then`
- How `then` with an array fans out, each target on its own forked thread
- How a join is recognized structurally and must use the `join()` builder
- How an edge back to an earlier node forms a loop

## Nodes

_One line each on `step`/`use`/`waitFor`/`interrupt`/`finish`. A small mermaid
diagram of the node kinds (reuse reference.md's Nodes/Edges/Emits diagram
style). TODO._

## Edges

_`when`/`otherwise`/`then`, forward-only. The audit example's `security`/
`performance`/`style` steps are each a named `Profile` — formally introduced
next, in Describing a flow. Example ref:
`docs/examples/wiring-a-graph/audit.ts#edges`._

## Fanning out

_`then([a, b, c])` — each branch on its own forked thread, no special return
value. Example ref: `#fan-out`._

## Joining

_The convergence node must be built with `join()` — the engine rejects a plain
step reached by converging fan-out edges, and rejects a `join()`-tagged node
reached as a single-input step. Example ref: `#join`._

## Loops

_A `then` back to an earlier node re-enables it as a new run. TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § The graph and why, § defineGraph (full block, including the audit fan-out/join example).
**Examples:** `docs/examples/wiring-a-graph/audit.ts` — regions: `edges`, `fan-out`, `join`.
**Section:** [Building the graph](./README.md)
**Prev / Next:** [Steps and emits](./steps-and-emits.md) / [Threads and forking](./threads-and-forking.md)
