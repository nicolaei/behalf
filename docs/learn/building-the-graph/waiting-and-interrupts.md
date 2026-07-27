# Waiting and interrupts

`Waitable` is what a `waitFor` or `interrupt` node parks on: the same small vocabulary whether it's
waiting on a message or a signal.

## You will learn

- How to read a `Waitable`'s three fields (`provider`, `label`, `match`)
- How to park a thread with `waitFor` until its `Waitable` resolves
- How to race a `waitFor` against an always-armed `interrupt`
- How to use `userInput(kind)`, the one built-in `Waitable`

## Waitable

A `Waitable` is three things: `provider` names which kind of thing can satisfy it, checked at boot
so a flow never discovers a missing wait source mid-run; `label` is a human-readable identity for
logs (and, as `waitFor: <label>`/`interrupt: <label>`, for a generated diagram's own node text);
`match` is a pure function over the committed session log, deciding whether the condition is met.

`match` never does its own I/O.
It only reads events already on the log, so replaying the same log always gives the same answer.
That's what makes a parked node resumable after a crash: the engine doesn't need to remember it was
waiting, it just re-checks `match` against the log it already has.

## waitFor

A `waitFor` node parks a thread until its `Waitable` resolves, then applies whatever it resolved to
onto that thread.
The chat example below waits for the next prompt after every reply:

```ts source=docs/examples/waiting-and-interrupts/chat.ts#wait-for
  const waitForPrompt = flow.waitFor(userInput("follow-up"));
```

Routing back into `respond` once it resolves is what turns this into a loop, the same mechanism
[Wiring a graph](./wiring-a-graph.md#loops) covers: an edge back to an earlier node re-enables it,
nothing special about `waitFor` itself makes it loop.

## interrupt

You might expect a `waitFor` node to be the only thing a flow can be parked on at any moment.
But an `interrupt` sits alongside it, always armed, from the moment its graph starts, not only while
a specific `waitFor` node happens to be current:

```ts source=docs/examples/waiting-and-interrupts/chat.ts#interrupt
  const stopped = flow.step(outputs(() => "Conversation ended."));
  const stop = flow.interrupt(
    userInput("stop"),
    outputs(() => undefined),
  );
```

Whichever condition is satisfied first wins the race, the currently-parked `waitFor`, or any armed
`interrupt`, and the loser keeps waiting.
Above, a `"stop"`-kind message wins the race the instant it arrives, however long `waitForPrompt`
has already been parked, and routes to `stopped` instead of back to `respond`.

A message-based interrupt (like `stop`, resolved by its `userInput` kind) and a signal-based one
(resolved by its own `match()` against the log) race the same way; only how each side is checked
differs.

> [!NOTE] `interrupt` fires wherever the graph currently is, not only next to a `waitFor`.
> It's the mechanism for "this can happen at any point," not "this can happen right here."

## userInput

`userInput(kind)` is the one built-in `Waitable`: it parks until a message tagged with that `kind`
arrives.

```ts source=docs/examples/waiting-and-interrupts/chat.ts#user-input
  const waitForPrompt = flow.waitFor(userInput("follow-up"));
```

The `kind` string, `"follow-up"` above, is a label you invent, not an API name.
Whoever eventually sends that message (a chat client, a CLI, another system) tags it with the exact
string a `waitFor` or `interrupt` is listening for; nothing else about the message's shape matters
to `userInput`.

## Recap

- A `Waitable` has three fields: `provider` (checked at boot), `label` (for logs and generated
  diagrams), `match` (a pure function over the committed log)
- `waitFor` parks a thread until its `Waitable` resolves, then applies the result to it
- `interrupt` is always armed, racing whatever `waitFor` is currently parked; whichever resolves
  first wins, the loser keeps waiting
- `userInput(kind)` is the one built-in `Waitable`; `kind` is a label you invent, not an API name
- Next: describe the messages, personas, and tools these steps actually call, in
  [Describing a flow](../describing-a-flow/README.md)

---

**Reference:** reference.md § Waitable, § defineGraph (waitFor/interrupt behaviour). **Examples:**
`docs/examples/waiting-and-interrupts/chat.ts`, regions: `wait-for`, `interrupt`, `user-input`.
**Section:** [Building the graph](./README.md) **Prev / Next:**
[Threads and forking](./threads-and-forking.md) /
[Messages and content](../describing-a-flow/messages-and-content.md)
