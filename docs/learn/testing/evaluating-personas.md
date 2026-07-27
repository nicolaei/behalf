# Evaluating personas

There's no built-in eval framework: this page is a **pattern**, not an API: scoring a persona's
outputs across a table of cases using ordinary vitest plus the testing tools from the previous two
pages.

## You will learn

- How to define a table of cases (input, expected property, not necessarily exact output)
- How to run a persona over each case with `runFlow` or `stepUntilBlocked`
- How to score an output: exact match, a rubric function, or a grading model call
- How to recognize when this pattern's lack of built-in aggregation calls for your own reporting

## Defining a case table

A case is a plain object: an input to send the persona, and a check for what a correct reply looks
like.
There's no `Case` type exported from any `@behalf-js/*` package: an array and an object literal are
already enough.

```ts source=docs/examples/evaluating-personas/matrix.test.ts#cases
interface Case {
  input: string;
  modelReply: string; // what the persona's underlying model says this turn
  check: (result: unknown) => boolean;
}

const cases: Case[] = [
  {
    input: "How do I reset my password?",
    modelReply: "RESOLVE",
    check: (result) => (result as { text: string }).text === "RESOLVE",
  },
  {
    input: "My account was hacked and I need this fixed now.",
    modelReply: "ESCALATE",
    check: (result) => (result as { text: string }).text === "ESCALATE",
  },
  {
    input: "What are your business hours?",
    modelReply: "RESOLVE",
    check: (result) => (result as { text: string }).text === "RESOLVE",
  },
];
```

`modelReply` here stands in for whatever a real model would say for that ticket: this table drives a
[scripted port](./setting-up-fakes.md#scripting-responses), one queued reply per case, so the table
stays deterministic without needing a live model for every case.

## Running a persona over each case

`it.each(cases)` turns the table into one vitest test per case, each with its own runtime and its
own scripted reply, so a failure names exactly which case broke. `triage` below is the persona under
test: a one-step flow whose system prompt asks for exactly `"RESOLVE"` or `"ESCALATE"`.

```ts source=docs/examples/evaluating-personas/matrix.test.ts#run-each
describe("triage persona", () => {
  it.each(cases)("classifies: $input", async ({ input, modelReply, check }) => {
    const ready = await runtime({
      models: () => scriptedPort([[{ type: "text", text: modelReply }]]),
      bindings: [],
      store: memoryStore(),
    });

    const result = await runFlow(triage, userText(input), ready);

    expect(check(result)).toBe(true);
  });
});
```

A flow with a wait point can use `stepUntilBlocked` here instead of `runFlow`, the same way
[Testing your flows](./testing-your-flows.md) does, if a case needs to assert on a mid-flight state
rather than the final result.

## Scoring

The cases above score by exact match: `check` compares the persona's output against one expected
string, pass or fail.
That's the simplest scoring a table like this can do, and the most honest one to actually run: it
needs no extra infrastructure, and a failure is unambiguous.

```ts source=docs/examples/evaluating-personas/matrix.test.ts#score
describe("scoring the whole table", () => {
  it("scores every case by exact match, one point each", async () => {
    let passed = 0;

    for (const testCase of cases) {
      const ready = await runtime({
        models: () => scriptedPort([[{ type: "text", text: testCase.modelReply }]]),
        bindings: [],
        store: memoryStore(),
      });
      const result = await runFlow(triage, userText(testCase.input), ready);
      if (testCase.check(result)) passed += 1;
    }

    expect(passed).toBe(cases.length);
  });
});
```

Two other scoring approaches are worth knowing, even without a full example each here:

- **A rubric function**: instead of one exact string, `check` scores a reply against several
  weighted criteria (did it mention the account, was the tone right) and returns a number instead of
  a boolean.
  This earns its place once "correct" genuinely isn't one fixed answer, at the cost of a scoring
  function that itself needs to be trusted and maintained.
- **A grading model call**: a second model reads the persona's output and judges it.
  This covers cases no rubric can express in code, free-form quality, but trades determinism for
  coverage: the grader can disagree with itself between runs, and now needs its own scripted port in
  a test that grades the grader.

## Limits of this pattern

This is a table and a loop, not a framework: nothing here aggregates results across cases into a
score, or reports which categories of ticket are weakest.
A table of ten cases is easy to eyeball from vitest's own pass/fail output; a table of a hundred
needs its own summary, and this pattern doesn't provide one.
A reader who needs that would add their own reporting on top: collecting each case's pass/fail into
an array and computing a percentage, or writing results to a file for a separate dashboard to read.
That's deliberately left to the reader, not something the library should grow, since the right shape
for a report depends entirely on what's being tracked.

## Recap

- A case is a plain `{ input, check }` object; an array of them is already a case table, no library
  type required
- `it.each(cases)` runs a persona over every case, one vitest test per case
- Exact match is the simplest, most honest scoring; a rubric function or a grading model call cover
  cases exact match can't, at the cost of determinism
- This pattern has no built-in aggregation or reporting: add it yourself, shaped to what you're
  actually tracking
- Next: stream a flow's progress to a client while it runs, in
  [Streaming progress](../streaming-and-sessions/streaming-progress.md)

---

**Reference:** none directly, this is a pattern built from § ModelPort, § runtime/runFlow, and
behalf/testing, not a documented API surface. **Examples:**
`docs/examples/evaluating-personas/matrix.test.ts`, regions: `cases`, `run-each`, `score`.
**Section:** [Testing](./README.md) **Prev / Next:** [Setting up fakes](./setting-up-fakes.md) /
[Streaming progress](../streaming-and-sessions/streaming-progress.md)
