# Threads and forking

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

A thread is one growing message context. `ThreadAction` — `same`, `fork`, or
`new` — is the one vocabulary every edge and `invalidate` uses to choose what
happens to it.

## You will learn

- What a thread is, and what `forkedFrom` vs `parentThreadId` each mean
- When to reach for `same`, `fork`, or `new`
- How forking from an earlier point is how you revert and branch
- How `{ label: "coder" }` gives a thread a stable, addressable name

## What a thread is

_Grows via `modelCall`, the inbox, and compaction — not via a step's `output`.
TODO._

## same, fork, new

_Default continue vs. a linked branch vs. a deliberate reset. Example ref:
`docs/examples/threads-and-forking/fork-and-revert.ts#actions`._

## Reverting by forking

_Fork from an earlier `at` — split onto a new id, leave the tail behind.
Example ref: `#revert`._

## Labeling threads

_`flow.step(run, { label })`. TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Threads.
**Examples:** `docs/examples/threads-and-forking/fork-and-revert.ts` — regions: `actions`, `revert`.
**Section:** [Building the graph](./README.md)
**Prev / Next:** [Wiring a graph](./wiring-a-graph.md) / [Waiting and interrupts](./waiting-and-interrupts.md)
