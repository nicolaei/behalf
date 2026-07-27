# The agent loop

One primitive covers three things that look different at first: a single reply, a turn that calls
tools, and a whole interactive chat. `agentTurn` calls the model, waits out whatever tools it asked
for, and either finishes or loops back — the same shape, however many times it repeats.

## You will learn

- How `agentTurn` loops a step that calls the model, until a response uses no tools
- Why a round of tool calls folds into the thread with a `compact`, and what that starts
- What `Response` and `Turn` mean precisely, reusing reference.md's own definitions
- How to end a turn early on a specific tool call with `finishOn`
- How an interactive chat is just one turn, looped, waiting for the next prompt in between

## The loop shape

`agentTurn` builds a graph, not a function you call once: `flow.use(agentTurn(persona))` composes it
as a single node, the same way [Quick start](../get-started/quick-start.md) used it for a one-shot
reply.

```ts source=docs/examples/the-agent-loop/chat.ts#turn
export const turn = agentTurn(assistant);
```

Inside, the shape is small: a step calls the model, then an edge checks whether that response used
any tools.
A response with no tools finishes the turn immediately.
A response that did use tools waits out every tool call, folds their results into the thread, and
loops back to call the model again.

That fold ends with `context.compact(...)`, not `context.output(...)`.
Per the Terms below, finishing a compaction begins a new turn — so each trip back through the loop
is a fresh turn that already sees the folded tool result, not a continuation of the same one.

You can also end a turn the instant a specific tool fires, instead of waiting for a tool-free
response: pass `finishOn: [{ on: "toolCall", name: "..." }]`, and the turn finishes early with that
call's own result. `{ on: "finalMessage" }` (a response with no tools) is always active regardless
of `finishOn` — you're adding an extra way out, not replacing the default one.

## Turn vs. response, precisely

- **Response** — one model call and the tools it invokes: the model replies, its tools run, and that
  produces one `AssistantMessage` (plus its tool results) on the log — one `modelCall`.
  There is no separate `Reply` type — a response _is_ an `AssistantMessage`.
- **Turn** — one user message (or a finished compaction) through the responses that follow, looping
  until a response needs no tools.
  A turn is one thread, one persona, one provider. `waitFor` parks between turns; steering folds
  into the current turn; finishing a compaction begins a new turn.

`agentTurn`'s loop is exactly this definition run as a graph: each pass through `respond` produces
one response, and the loop keeps producing responses, folding tool results with a `compact` between
them, until a response needs no tools.
That's the moment the turn ends.

## Building a chat from one turn

An interactive chat doesn't need a second primitive.
It loops the same turn, waits between runs, and stays on one thread throughout.

```ts source=docs/examples/the-agent-loop/chat.ts#chat
export const chat = defineGraph("chat", (flow) => {
  const loop = flow.use(turn);
  const waitForPrompt = flow.waitFor(userInput("follow-up"));
  flow.entry(loop);
  loop.then(waitForPrompt); // turn finished → wait for the next prompt
  waitForPrompt.then(loop); // new prompt → run another turn, same thread
});
```

`waitForPrompt.then(loop)` loops back into the very turn that just ran — nothing here starts a new
thread. `chat.test.ts`'s own scripted-port test proves it: the third model call's messages still
include the very first prompt, sent two turns earlier.

> [!NOTE] `then` defaults to `threadAction: "same"`, so this loop never needs to spell it out.
> See [Threads and forking](../building-the-graph/threads-and-forking.md) for the full contract.

## Recap

- `agentTurn` loops a model-calling step until a response needs no tools, then finishes
- A round of tool calls folds into the thread with `compact`, which starts a new turn on the same
  thread, not a new thread
- `finishOn: [{ on: "toolCall", name }]` ends a turn early on a specific call; `finalMessage` is
  always active underneath it
- A `Response` is one model call and its tools; a `Turn` is the responses that follow one user
  message until one needs no tools
- An interactive chat is `agentTurn`, looped with a `waitFor(userInput(...))` between runs, same
  thread throughout
- Next: fan a prompt out to several personas at once, in
  [Fan-out and joining](./fan-out-and-joining.md)

---

**Reference:** reference.md § Terms (Response/Turn), § Full examples #1 (agentTurn + chat).
**Examples:** `docs/examples/the-agent-loop/chat.ts` — regions: `turn`, `chat`. **Section:**
[Agents in practice](./README.md) **Prev / Next:**
[Tools and handlers](../describing-a-flow/tools-and-handlers.md) /
[Fan-out and joining](./fan-out-and-joining.md)
