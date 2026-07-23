# Testing your flows

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

`behalf/testing` wraps the engine's internal `tick`/`tickUntilSuspended` in a
test author's own vocabulary — the same way a fake-timer library wraps a
runtime's clock.

## You will learn

- Why this is a separate entry point, not part of `src/index.ts`
- The difference between `stepOnce` and `stepUntilBlocked`
- How `stepUntil` plus `atNode` drives a flow to a specific point
- What `StepUntilError` tells you when a flow stalls or exceeds its budget

## Why a separate entry point

_Purpose-built verbs (`StepState`, `laneId`) instead of raw engine internals
(`CursorState`, `parent`). TODO._

## Stepping one node at a time

_`stepOnce` — one `StepResult`, one `StepState` per independently-progressing
lane. Example ref: `docs/examples/testing-your-flows/step-through.ts#step-once`._

## Driving until blocked

_`stepUntilBlocked` — every lane parked or done. Example ref: `#until-blocked`._

## Stepping until a condition

_`stepUntil(flow, runtime, condition)`, `atNode(handle)`; `"stalled"` vs
`"budget-exceeded"`. Example ref: `#step-until`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Testing (full block: stepOnce/stepUntilBlocked, stepUntil/atNode/StepUntilError).
**Examples:** `docs/examples/testing-your-flows/step-through.ts` — regions: `step-once`, `until-blocked`, `step-until`.
**Section:** [Testing](./README.md)
**Prev / Next:** [Model ports and bindings](../wiring-a-runtime/model-ports-and-bindings.md) / [Setting up fakes](./setting-up-fakes.md)
