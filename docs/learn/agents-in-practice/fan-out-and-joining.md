# Fan-out and joining

One prompt, several personas working on their own forked threads at once, merged back into a single
reply.

## You will learn

- How `then([a, b, c])` fans a step's output out to several branches, each on its own forked thread
- How each branch reaches the merge point by an ordinary `.then()` edge, no special return value
- Why the convergence node must be built with `join()`, and what the engine rejects if it isn't
- How the join step reads `context.inputs`, one entry per branch, in branch-declared order

## Fanning out

An array is the whole trigger. `then(target)` continues to one step; `then([a, b, c])` continues to
several, each getting the same output, each running on its own forked thread.

```ts source=docs/examples/fan-out-and-joining/audit.ts#fan-out
export const audit: Graph = defineGraph("audit", (flow) => {
  const intake = flow.step(
    outputs((context) => context.thread.messages.at(-1)),
    {
      label: "intake",
    },
  );
  const security = flow.step(reviewStep("security", securityReviewer), { label: "security" });
  const performance = flow.step(reviewStep("performance", performanceReviewer), {
    label: "performance",
  });
  const style = flow.step(reviewStep("style", styleReviewer), { label: "style" });

  flow.entry(intake);
  intake.then([security, performance, style]); // fan out — each on its own forked thread
```

`intake` reads the last message once and hands it to three reviewer personas, each with its own
system prompt.
Forking gives every branch its own thread: `security`'s call to the model never sees `performance`'s
reply, and neither sees the other's — `audit.test.ts` asserts this directly, checking that the
store's committed events span at least four distinct thread ids: the original plus one per branch.

## Reaching the join

A branch doesn't return to a special join function; it just runs its own chain of ordinary steps
until that chain reaches the shared convergence node.
Here each branch is one step (`reviewStep`, a small wrapper around a `context.modelCall` that shapes
the reply into a `Review`), so "the branch's chain" is a single edge.
A longer branch, several steps validating or transforming a result before it merges, reaches the
join exactly the same way, one `.then()` at a time.

## The join() builder

The convergence point isn't found by wiring alone: it has to be built with `join()`, tagging the
step so the engine recognizes it as a fan-out's merge point rather than an ordinary single-input
step.

```ts source=docs/examples/fan-out-and-joining/audit.ts#join
  const merge = flow.step(
    join((context) => context.inputs as Review[]),
    { label: "merge" },
  );
  security.then(merge); // each branch reaches the join by an ordinary edge
  performance.then(merge);
  style.then(merge);
```

`context.inputs` holds one entry per branch, in the order the branches were declared in the `then`
array — `[security's review, performance's review, style's review]` here, not arrival order. `merge`
casts that array to `Review[]` and returns it as-is; the `reply` step right after reads it back out
of `context.inputs[0]` to build the final summary.

Wiring this wrong is a mistake the engine catches immediately, in either direction: a convergence
node reached by more than one branch but built as a plain `outputs(...)` step throws (it was "not
defined with `join()`"), and a `join()`-tagged step reached through an ordinary single-input chain
throws too (it "was reached as a plain step").
Neither failure waits for a subtle bug in `context.inputs`; both fail loudly at the point the graph
first runs.

## Full example

The whole file: three reviewers fanning out from one prompt, converging on `merge`, then a `reply`
step that reads all three reviews back out and writes the combined summary.

```ts source=docs/examples/fan-out-and-joining/audit.ts
// The Learn "Fan-out and joining" page's example: three reviewer personas
// run in parallel on their own forked threads over the same prompt, then
// converge on a merge step tagged with join() before a lead step writes the
// final reply. Driven with a scripted ModelPort in audit.test.ts, not a real
// provider, so the fan-out and the join are both actually exercised.

import { defineGraph, outputs, join } from "@behalf-js/core";
import type { Graph, Profile, Model, StepContext } from "@behalf-js/core";

const reviewModel: Model = {
  identifier: "scripted",
  provider: "test",
  contextWindow: 1000,
  reasoning: [],
};

export const securityReviewer: Profile = {
  model: reviewModel,
  system: "Review this change for security issues in one short sentence.",
  tools: [],
};
export const performanceReviewer: Profile = {
  model: reviewModel,
  system: "Review this change for performance issues in one short sentence.",
  tools: [],
};
export const styleReviewer: Profile = {
  model: reviewModel,
  system: "Review this change for style issues in one short sentence.",
  tools: [],
};

/** One reviewer's finding, tagged with its own name so the join step can tell them apart. */
interface Review {
  reviewer: string;
  note: string;
}

function lastAssistantText(context: StepContext): string {
  const last = context.thread.messages.at(-1);
  const block =
    last?.role === "assistant" ? last.content.find((b) => b.type === "text") : undefined;
  return block?.type === "text" ? block.text : "";
}

function reviewStep(reviewer: string, persona: Profile) {
  return async (context: StepContext) => {
    await context.modelCall(persona);
    return context.output({ reviewer, note: lastAssistantText(context) } satisfies Review);
  };
}

export const audit: Graph = defineGraph("audit", (flow) => {
  const intake = flow.step(
    outputs((context) => context.thread.messages.at(-1)),
    {
      label: "intake",
    },
  );
  const security = flow.step(reviewStep("security", securityReviewer), { label: "security" });
  const performance = flow.step(reviewStep("performance", performanceReviewer), {
    label: "performance",
  });
  const style = flow.step(reviewStep("style", styleReviewer), { label: "style" });

  flow.entry(intake);
  intake.then([security, performance, style]); // fan out — each on its own forked thread

  const merge = flow.step(
    join((context) => context.inputs as Review[]),
    { label: "merge" },
  );
  security.then(merge); // each branch reaches the join by an ordinary edge
  performance.then(merge);
  style.then(merge);

  const reply = flow.step(
    outputs((context) => {
      const reviews = context.inputs[0] as Review[];
      const noteFrom = (reviewer: string) =>
        reviews.find((review) => review.reviewer === reviewer)?.note ?? "";
      return {
        summary:
          `security: ${noteFrom("security")} ` +
          `performance: ${noteFrom("performance")} ` +
          `style: ${noteFrom("style")}`,
      };
    }),
    { label: "reply" },
  );
  merge.then(reply);
  reply.then(flow.finish);
});
```

## Recap

- `then([a, b, c])` fans a step's output out to several branches, each on its own forked thread
- A branch reaches the join by an ordinary `.then()` chain — there's no special return value that
  marks "this is the last step in a branch"
- The convergence node must be built with `join()`; the engine rejects the wiring either direction
  if it isn't
- `context.inputs` in a join step holds one entry per branch, in declared order
- Next: what happens when one of those steps breaks instead of just disagreeing, in
  [Handling errors](./handling-errors.md)

---

**Reference:** reference.md § defineGraph (join() / JoinStep), § Full examples #2 (the audit graph).
**Examples:** `docs/examples/fan-out-and-joining/audit.ts` — regions: `fan-out`, `join`; plus a
"Full example" block for the whole graph. **Section:** [Agents in practice](./README.md) **Prev /
Next:** [The agent loop](./the-agent-loop.md) / [Handling errors](./handling-errors.md)
