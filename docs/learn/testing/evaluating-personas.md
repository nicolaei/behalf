# Evaluating personas

`@behalf-js/testing/eval` scores a persona's outputs across a table of cases: `example()` builds the
table, a scorer grades each run, and `scenario`/`explore` are the two ways to act on the result.

## You will learn

- How to build a case table with `example()`
- How to score a run with a built-in scorer, including `llmJudge` with an injected `Judge`
- How to gate CI on a persona's behaviour with `scenario()`
- How to compare variants of a persona with `explore()` and `grid()`, ranked several ways from one
  execution pass
- What this library still leaves for you to build

## Defining a case table

`example(name, { world, fixtures, input })` builds one row of a dataset. `world()` returns fresh
mutable state for that row; `fixtures(world, profile)` returns the fakes (a `ModelPort`, tool
bindings) that row runs against, the same [scripted port](./setting-up-fakes.md#scripting-responses)
and `provide` bindings the previous two pages already use; `input` is the message that starts the
run. `triage` below is the persona under test: a one-step agent whose system prompt asks for exactly
`"RESOLVE"` or `"ESCALATE"`.

```ts source=docs/examples/evaluating-personas/matrix.test.ts#agent
const basicProfile: Profile = {
  model: { identifier: "claude-haiku", provider: "test", contextWindow: 100_000, reasoning: [] },
  system:
    'Read this support ticket and reply with exactly one word: "RESOLVE" if you can answer it ' +
    'directly, "ESCALATE" if it needs a person.',
  tools: [],
};

const triage = agent<World>("support-triage", basicProfile);
```

```ts source=docs/examples/evaluating-personas/matrix.test.ts#cases
const cases = [
  example<World>("password-reset", {
    world: () => ({ ticket: "How do I reset my password?" }),
    fixtures: () => ({ models: scriptedPort([[{ type: "text", text: "RESOLVE" }]]), bindings: [] }),
    input: userText("How do I reset my password?"),
  }),
  example<World>("account-hacked", {
    world: () => ({ ticket: "My account was hacked and I need this fixed now." }),
    fixtures: () => ({ models: scriptedPort([[{ type: "text", text: "ESCALATE" }]]), bindings: [] }),
    input: userText("My account was hacked and I need this fixed now."),
  }),
  example<World>("business-hours", {
    world: () => ({ ticket: "What are your business hours?" }),
    fixtures: () => ({ models: scriptedPort([[{ type: "text", text: "RESOLVE" }]]), bindings: [] }),
    input: userText("What are your business hours?"),
  }),
];
```

`agent(name, profile)` wraps a `Profile` as the thing under eval: `scenario` runs it as-is, and
`explore` re-profiles it per variant with `.with(partial)`, covered below. `fixtures` receives the
resolved `Profile`, not just `world`, so a row can pick its fake model by
`profile.model.identifier` when the same case runs against several variants.

## Scoring a run

Every scorer reads a `Run`, the folded record of one execution: its output, its world, every tool
call, and its last reply per thread. A scorer maps a `Run` to a number in `[0, 1]` and carries its
own pass bar (`minimumScore`, default `1`).

The built-in scorers cover the exact-match cases: `toolCalled(name)` and `toolCalledWith(name, ok)`
check `run.tools`; `worldMatches(ok)` and `outputMatches(ok)` run a predicate against `run.world` or
`run.output`; `saidOn(thread, pattern)` matches the last reply's text against a string or `RegExp`.
All five return `0` or `1`, so grading them by eye ("did it happen, yes or no") is always honest.

```ts source=docs/examples/evaluating-personas/matrix.test.ts#scorers
const scorers = [
  outputMatches((output) => typeof output === "object" && output !== null),
  llmJudge("polite and on-topic", { minimumScore: 0.7 }, fakeJudge),
];
```

`llmJudge(rubric, bars, judge?)` is the one scorer that isn't boolean: an injected `Judge` rates the
last reply against `rubric`, 0 to 1. `bars` is mandatory here, with no default, because a judged
score is continuous: there's no honest universal pass bar, so you always state your own
`minimumScore`. Without a `judge` argument, `llmJudge` throws instead of silently calling a real
model, which is what keeps a test deterministic and free to run in CI without a live key.

```ts source=docs/examples/evaluating-personas/matrix.test.ts#judge
const fakeJudge: Judge = {
  rate: () => Promise.resolve(0.9),
};
```

> [!TIP] `scoreBy(name, fn)` is the escape hatch when none of the built-ins fit: any
> `(run) => number` becomes a scorer, still folded into the same `Distribution` as the others.

## Gating CI with scenario

`scenario(name, spec)` registers a vitest test that fails when a persona's behaviour doesn't hold:
one `Subject`, a case table, a run count, and scorers with pass bars. Each row runs `spec.runs`
times, every run folds into a `Run`, and each scorer's scores across all of them fold into a
`Distribution` (mean, median, stddev, min, max, pass rate). `scenario` passes only when every scorer
clears its own bar.

```ts source=docs/examples/evaluating-personas/matrix.test.ts#scenario
scenario("support-triage classifies every ticket", {
  of: triage,
  given: cases,
  runs: 3,
  scorers,
});
```

A `scenario` can also check regression against a stored baseline (`regression: variance(k)` or
`fixed(epsilon)`, `baseline: { store, test }`): today's distribution compares against the last time
this scorer passed, and a scorer that regresses fails the gate even if it still clears its own bar.
The baseline is ratcheted per scorer: one that fails or regresses keeps its old baseline, so a bad
run never becomes the new floor. This is a deeper feature than a first eval needs; reach for it once
a scenario's numbers matter enough that a silent decline would be worth catching.

## Comparing variants with explore and grid

`scenario` answers "did this persona still behave." `explore(name, spec)` answers "which variant is
best," and never fails CI: it always registers a passing `it("ranks", ...)`, because a comparison
isn't a regression test.

`explore` takes the same case table and scorers as `scenario`, plus a list of `variants`: partial
`Profile`s applied to the base agent with `.with()`. Writing that list by hand gets tedious past two
axes, so `grid(axes)` builds the cross-product for you: `{ model: [a, b], system: [x, y] }` becomes
four variants, not four lines you typed out.

```ts source=docs/examples/evaluating-personas/matrix.test.ts#explore
explore("support-triage: model and system prompt compared", {
  of: triage,
  variants: grid({
    model: [
      { identifier: "claude-haiku", provider: "test", contextWindow: 100_000, reasoning: [] },
      { identifier: "claude-sonnet", provider: "test", contextWindow: 100_000, reasoning: [] },
    ],
    system: [basicProfile.system, "Reply with RESOLVE or ESCALATE, and nothing else."],
  }), // 2 x 2 = 4 variants
  given: cases, // 3 cases
  runs: 3, // 3 runs per (variant x case)
  scorers,
  rankBy: {
    quality: byScore,
    speed: byTimeToComplete,
    cost: byTokens,
  },
});
```

This runs 4 variants × 3 cases × 3 runs, 36 executions total, once. `rankBy` takes either one `Rank`
function or, as above, a named map of them: `byScore` (highest mean score first), `byTimeToComplete`
(fastest first), `byTokens` (fewest tokens first), and `byCost` (free or local first, then cheaper,
unknown price last) all ship as part of the library. A named map doesn't run anything twice: every
variant's runs and metrics are computed exactly once, and each entry in `rankBy` just sorts that same
computed array a different way. `result.rankings.quality[0]` is the best-scoring variant;
`result.rankings.speed[0]` is the fastest; both come from the same 36 executions, not a second pass.

You might expect asking three questions ("best," "fastest," "cheapest") to cost three explore runs.
It doesn't: `runExplore` folds every variant's runs into one `ExploreVariantResult` array before it
ever looks at `rankBy`, then sorts that array once per name. Comparing variants five different ways
is one execution pass regardless of how many rankers you ask for.

## What's still not provided

`scenario` and `explore` are the real API: this page teaches it, not a workaround for its absence.
What they don't do is report: `explore` returns a sorted array, and that's the whole output. Nothing
here writes a persisted report, renders a dashboard, or tracks a history of runs beyond one
`BaselineStore` per scorer. A reader of ten variants can read `result.rankings` directly; a reader
who wants a chart, a spreadsheet, or a trend line across weeks of runs still builds that themselves
on top of the arrays these functions return.

## Recap

- `example(name, { world, fixtures, input })` builds one dataset row; an array of them is a case
  table
- `toolCalled`, `toolCalledWith`, `worldMatches`, `outputMatches`, and `saidOn` score by exact match;
  `llmJudge(rubric, bars, judge)` scores continuously with an injected `Judge`, and `bars` has no
  default
- `scenario(name, spec)` gates CI: it fails when any scorer misses its bar across the case table,
  and can optionally check regression against a stored baseline
- `explore(name, spec)` never fails CI: it ranks `grid()`-built variants by one or several named
  `Rank` functions, computed once and sorted per name
- Neither function reports beyond the arrays they return: a dashboard or a persisted history is
  still yours to build
- Next: stream a flow's progress to a client while it runs, in
  [Streaming progress](../streaming-and-sessions/streaming-progress.md)

---

**Reference:** none directly; see `@behalf-js/testing/eval`'s own exports (`agent`, `example`,
scorers, `scenario`, `explore`, `grid`, `Rank` functions). **Examples:**
`docs/examples/evaluating-personas/matrix.test.ts`, regions: `agent`, `cases`, `judge`, `scorers`,
`scenario`, `explore`. **Section:** [Testing](./README.md) **Prev / Next:**
[Setting up fakes](./setting-up-fakes.md) /
[Streaming progress](../streaming-and-sessions/streaming-progress.md)
