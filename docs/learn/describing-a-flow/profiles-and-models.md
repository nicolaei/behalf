# Profiles and models

A `Model` describes what a provider can do; a `Profile` is the persona built on top of one, the
thing a step actually calls.

## You will learn

- How to read a `Model` descriptor: identity, context window, reasoning levels, price
- How to build a `Profile`: model, system prompt, tools, reasoning
- How a persona's `reasoning` is checked against its model's supported levels
- How cost is derived from price and usage

## Model

A `Model` is a structured descriptor, not a live connection: identity, how much context it holds,
which reasoning levels it supports, and what it costs.
A step never talks to the model directly, so nothing here needs to know how to make a request; a
`ModelPort` does that, matched to this descriptor at runtime (see
[Model ports and bindings](../wiring-a-runtime/model-ports-and-bindings.md)).

```ts source=docs/examples/profiles-and-models/basic.ts#model
export const supportModel: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off", "low", "medium", "high"],
  price: { input: 3, output: 15 },
};
```

`reasoning` lists every level this model actually supports, not the full `ReasoningLevel` set: an
empty array means the model has no extended thinking at all. `price` is optional and per-token; the
engine uses it to derive `usage.cost` on each assistant message, and leaves `cost` absent when a
model has no known price.

## Profile

A `Profile` is the persona: the model it calls, its system prompt, the tools it may use, and
optionally which reasoning level to ask for.

```ts source=docs/examples/profiles-and-models/basic.ts#profile
export const supportAgent: Profile = {
  model: supportModel,
  system: "You triage support tickets and answer what you can without escalating.",
  tools: [],
  reasoning: "medium",
};
```

`tools` takes both `Tool` and `Toolset` entries in the same array; see
[Tools and handlers](./tools-and-handlers.md) for what each is and how it gets bound to an
implementation.

## Reasoning levels and coverage

`reasoning` on a `Profile` isn't free text: it must be one of the levels its own `model.reasoning`
lists.
You might expect an unsupported level to just get ignored or clamped to the nearest one at call
time, but it's neither: it's a coverage-check failure, caught before the flow ever runs, not a
runtime surprise buried in a failed API call.

`satisfiesFlows` is what runs that check: given every persona in play across your flows, it reports
back exactly what's missing, an unsupported reasoning level among it.
[Running flows](../wiring-a-runtime/running-flows.md) covers `satisfiesFlows` in full; the point
here is narrower: a `Profile`'s `reasoning` field is a contract with its `model`, not a suggestion.

## Recap

- A `Model` is identity, `contextWindow`, the `reasoning` levels it supports, and an optional
  `price`
- A `Profile` is a model, a system prompt, its tools, and an optional `reasoning` level
- `tools` mixes `Tool` and `Toolset` entries in one array
- A `Profile`'s `reasoning` must be one its model actually supports, checked before the flow runs
- Cost is derived from `price` and `usage`, absent when the model's price is unknown
- Next: how a persona's tools get declared and wired to real code, in
  [Tools and handlers](./tools-and-handlers.md)

---

**Reference:** reference.md § Model, § Profile. **Examples:**
`docs/examples/profiles-and-models/basic.ts`, regions `model`, `profile`. **Section:**
[Describing a flow](./README.md) **Prev / Next:** [Messages and content](./messages-and-content.md)
/ [Tools and handlers](./tools-and-handlers.md)
