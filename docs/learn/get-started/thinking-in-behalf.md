# Thinking in behalf

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

The tutorial: design one small flow from scratch — a support-ticket triage
agent — using the same five-step methodology "Thinking in React" uses for UI.

## You will learn

- How to identify the turns and personas a problem needs
- How to sketch a graph's shape before writing any wiring code
- How to choose `same`/`fork`/`new` threading per edge
- How to add a wait point for human input
- How to add error handling last, once the happy path works

## Step 1: Identify the turns

_What's one turn here — triage, then escalate or resolve. One persona per
turn. TODO._

## Step 2: Sketch the shape

_Draw it before wiring it — a small mermaid flowchart. TODO._

## Step 3: Choose threading

_Same thread for the loop; `new` where context should reset. TODO._

## Step 4: Add a wait point

_`waitFor(userInput(...))` between turns. TODO._

## Step 5: Add error handling

_A minimal `ErrorHandler`, added last. TODO._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § The graph and why, § Threads, § ErrorHandler.
**Examples:** `docs/examples/thinking-in-behalf/triage.ts` — regions: `shape`, `threading`, `wait-point`, `error-handling`; built incrementally, one region added per step.
**Section:** [Get started](./README.md)
**Prev / Next:** [Quick start](./quick-start.md) / [Steps and emits](../building-the-graph/steps-and-emits.md)
