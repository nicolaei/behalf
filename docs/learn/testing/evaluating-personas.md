# Evaluating personas

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

There's no built-in eval framework — this page is a **pattern**, not an API: scoring a persona's
outputs across a table of cases using ordinary vitest plus the testing tools from the previous two
pages.

## You will learn

- How to define a table of cases (input, expected property, not necessarily exact output)
- How to run a persona over each case with `runFlow` or `stepUntilBlocked`
- How to score an output — exact match, a rubric function, or a grading model call
- Where this pattern's limits are, and why it's a recipe, not a framework feature

## Defining a case table

_A plain array of `{ input, check }` — no special type from the library.
Example ref: `docs/examples/evaluating-personas/matrix.test.ts#cases`._

## Running a persona over each case

_`it.each`/a loop over `runFlow`.
Example ref: `#run-each`._

## Scoring

_Exact match vs. a rubric vs. a second model call as grader — trade-offs of each.
Example ref: `#score`._

## Limits of this pattern

_No built-in aggregation/reporting — say so plainly, and point at what a reader would need to add
themselves.
TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** none directly — this is a pattern built from § ModelPort, § runtime/runFlow, and
behalf/testing, not a documented API surface. **Examples:**
`docs/examples/evaluating-personas/matrix.test.ts` — regions: `cases`, `run-each`, `score`.
**Section:** [Testing](./README.md) **Prev / Next:** [Setting up fakes](./setting-up-fakes.md) /
[Streaming progress](../streaming-and-sessions/streaming-progress.md)
