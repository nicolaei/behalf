# Threads and forking

A thread is one growing message context. `ThreadAction`, `same`, `fork`, or `new`, is the one
vocabulary every edge and `invalidate` uses to choose what happens to it.

## You will learn

- What a thread is, and what `forkedFrom` vs `parentThreadId` each mean
- When to reach for `same`, `fork`, or `new`
- How forking from an earlier point is how you revert and branch
- How `{ label: "coder" }` gives a thread a stable, addressable name

## What a thread is

A thread grows the same way a conversation does: `modelCall` appends the model's reply, the inbox
folds in a message that arrives while it's waiting, and compaction can rewrite it into a lighter new
turn.
A step's own `output` never touches a thread directly: that value only ever travels through
`context.inputs`, as [Steps and emits](./steps-and-emits.md) covered.

Two ids describe how one thread relates to another. `forkedFrom: { thread, at }` is a tree on an
existing thread: this thread split off another one at a specific point in its history.
`parentThreadId` is ownership instead of ancestry: the thread a spawned sub-agent belongs to, not
one it branched from.
A forked thread and its parent can both trace back to the same origin; a child thread and its parent
are simply two separate threads, one of which spawned the other.

## same, fork, new

Every edge (and every `invalidate`) picks one of three actions for the thread it leads to:

```ts source=docs/examples/threads-and-forking/fork-and-revert.ts#actions
  draft.then(review); // same (default) — review continues the draft's own thread

  review.when((output) => (output as Verdict).approved, notify, {
    threadAction: "new", // deliberate reset — notify only needs the final text
    prompt: (output) => userText((output as Verdict).text),
  });

  review.otherwise(draft, {
    threadAction: "fork", // revert — split onto a new thread, seeded with feedback
    prompt: (output) => userText((output as Verdict).text),
  });
```

`same` is the default: the next node just keeps writing to the thread it's already on, context
growing with every step. `draft.then(review)` above never mentions a `threadAction` at all, because
`review` genuinely needs everything `draft` just wrote.
There's no reason to reach for anything else.

`new` is a deliberate reset: a brand-new thread whose only message is whatever `prompt` builds.
`notify` above never sees the draft/review back-and-forth, only the approved text.
It doesn't need the history that produced it, so carrying it forward would just be dead weight on
every future model call.

`fork` sits between the two: a new thread id that shares the current thread's history up to the
split, linked back by `forkedFrom`.
The next section covers exactly what that buys you.

> [!TIP] `same` is also the type's default, so writing it out (as `draft.then(review)` doesn't,
> above) is never required.
> Spelling it out anyway, the way [Thinking in behalf](../get-started/thinking-in-behalf.md) does,
> is worth doing when the choice itself is the point you're making, not because the code needs it.

## Reverting by forking

You might reach for `same` on a rejected review, since the retry still needs the original draft in
front of it.
But `same` would keep piling the rejected attempt and its feedback onto one ever-growing thread, so
a second rejection has to wade through the first attempt's mess to find what actually needs fixing.
`fork` instead:

```ts source=docs/examples/threads-and-forking/fork-and-revert.ts#revert
  review.otherwise(draft, {
    threadAction: "fork", // revert — split onto a new thread, seeded with feedback
    prompt: (output) => userText((output as Verdict).text),
  });
```

Forking from the rejection splits onto a new thread id at that point: the new thread still shares
everything up to the split (`forkedFrom: { thread, at }` points back to it), but the retry's own
messages (this feedback, the next draft, the next review) build up on a clean branch instead of
piling onto the same one.
The original, rejected attempt is still reachable through `forkedFrom`; it just isn't what the
retry's own model calls see going forward.

This is the general shape for reverting and branching: fork from whatever point you want to keep,
seed the new thread with a `prompt`, and the tail that came after the split is left behind on the
old thread, untouched.

## Labeling threads

`flow.step(run, { label })` names the node, what a generated diagram shows in its box instead of an
opaque `node-3`, and, the moment that step runs, stamps its `label` onto the thread it ran on.
The thread keeps that label until a later labeled step overwrites it, so a UI or a log line can
address "the coder's thread" by name instead of its generated `ThreadId`.

The `audit` example in [Wiring a graph](./wiring-a-graph.md#joining) labels every step this way.
Its generated diagram reads "security"/"performance"/"style" instead of `node-3`/`node-4`/`node-5`
as a direct result: the same option, read by the diagram generator instead of the runtime.

## Recap

- A thread grows via `modelCall`, the inbox, and compaction, never via a step's own `output`
- `forkedFrom` is ancestry (a fork's own tree); `parentThreadId` is ownership (a spawned sub-agent)
- `same` keeps writing to the current thread; `new` is a deliberate reset; `fork` splits onto a new
  id that still shares history up to that point
- Reverting is forking from the point worth keeping, seeded with a `prompt`.
  The tail after that point is left behind, still reachable, just not on the retry's own thread
- `{ label }` gives a thread a stable, readable name for logs and generated diagrams
- Next: what a `waitFor`/`interrupt` node actually parks on, in
  [Waiting and interrupts](./waiting-and-interrupts.md)

---

**Reference:** reference.md § Threads. **Examples:**
`docs/examples/threads-and-forking/fork-and-revert.ts`, regions: `actions`, `revert`. **Section:**
[Building the graph](./README.md) **Prev / Next:** [Wiring a graph](./wiring-a-graph.md) /
[Waiting and interrupts](./waiting-and-interrupts.md)
