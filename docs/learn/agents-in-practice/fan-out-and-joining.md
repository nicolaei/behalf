# Fan-out and joining

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

One prompt, several personas working in parallel on their own forked threads,
merged back into a single reply.

## You will learn

- How `then([a, b, c])` fans out, each branch on its own forked thread
- How each branch reaches the join by an ordinary `.then()` edge — no special
  return value
- Why the convergence node must be built with `join()`, and what the engine
  rejects if it isn't
- How the join step reads `context.inputs` — one entry per branch

## Fanning out

_`intake.then([security, performance, style])`. Example ref:
`docs/examples/fan-out-and-joining/audit.ts#fan-out`._

## Reaching the join

_Every branch just runs its own chain to whatever handle it ends at. TODO._

## The join() builder

_Structural recognition + validation; wrong wiring is rejected either
direction. Example ref: `#join`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § defineGraph (join() / JoinStep), § Full examples #2 (the audit graph).
**Examples:** `docs/examples/fan-out-and-joining/audit.ts` — regions: `fan-out`, `join`; plus a "Full example" block for the whole graph.
**Section:** [Agents in practice](./README.md)
**Prev / Next:** [The agent loop](./the-agent-loop.md) / [Handling errors](./handling-errors.md)
