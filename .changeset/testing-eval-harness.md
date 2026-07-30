---
"@behalf-js/testing": patch
---

New `@behalf-js/testing/eval` subpath export: a persona/quality evaluation
harness for scoring behalf flows across cases, separate from the
existing `stepOnce`/`stepUntilBlocked`/`stepUntil` flow-testing
vocabulary. Adds `scenario`/`explore` for defining and running cases
against a `Subject` (`agent`), `example`/`Fixtures` for case data,
scorers (`toolCalled`, `toolCalledWith`, `worldMatches`, `outputMatches`,
`saidOn`, `scoreBy`), an `llmJudge` for model-graded scoring,
regression-checking (`variance`/`fixed`/`checkRegression`,
`jsonlBaselineStore`), and harness utilities (`gate`, `aggregate`, `grid`
+ ranking by score/time/tokens/cost). Not re-exported from the package's
top-level `index` — opt in explicitly via the `/eval` subpath.
