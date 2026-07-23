# Waiting and interrupts

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

`Waitable` is what a `waitFor` or `interrupt` node parks on — the same small vocabulary whether it's
waiting on a message or a signal.

## You will learn

- The three fields of a `Waitable`: `provider`, `label`, `match`
- How `waitFor` parks until its `Waitable` resolves
- How `interrupt` races alongside a `waitFor`, always armed, whichever condition resolves first wins
- How `userInput(kind)` is the one built-in `Waitable`

## Waitable

_`provider` (checked at boot by `satisfiesFlows`), `label` (for logs), `match` (pure function over
the log).
TODO._

## waitFor

_Parks until resolved, then applies the result to the thread.
Example ref: `docs/examples/waiting-and-interrupts/chat.ts#wait-for`._

## interrupt

_Always armed; races whatever `waitFor` is currently parked; the loser keeps waiting.
TODO._

## userInput

_The built-in message-based `Waitable`.
Example ref: `#user-input`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Waitable, § defineGraph (waitFor/interrupt behaviour). **Examples:**
`docs/examples/waiting-and-interrupts/chat.ts` — regions: `wait-for`, `user-input`. **Section:**
[Building the graph](./README.md) **Prev / Next:** [Threads and forking](./threads-and-forking.md) /
[Messages and content](../describing-a-flow/messages-and-content.md)
