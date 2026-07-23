# Profiles and models

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

A `Model` describes what a provider can do; a `Profile` is the persona built
on top of one — the thing a step actually calls.

## You will learn

- What a `Model` descriptor captures: identity, context window, reasoning levels, price
- How to build a `Profile`: model, system prompt, tools, reasoning
- How a persona's `reasoning` is checked against its model's supported levels
- How cost is derived from price and usage

## Model

_Identity, `contextWindow`, `reasoning: ReasoningLevel[]`, optional `price`.
Example ref: `docs/examples/profiles-and-models/basic.ts#model`._

## Profile

_model + system + tools + optional reasoning. Example ref: `#profile`._

## Reasoning levels and coverage

_Why an unsupported level is a coverage-check failure, not a runtime surprise
— forward ref to `satisfiesFlows` in Running flows. TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Model, § Profile.
**Examples:** `docs/examples/profiles-and-models/basic.ts` — regions: `model`, `profile`.
**Section:** [Describing a flow](./README.md)
**Prev / Next:** [Messages and content](./messages-and-content.md) / [Tools and handlers](./tools-and-handlers.md)
