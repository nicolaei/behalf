# The agent loop

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

`agentTurn` is one shape — repeat a `modelCall` until a response needs no tools — that covers a
single reply, a tool-using turn, and (looped) an entire interactive chat.

## You will learn

- How `agentTurn` loops one `PersonaStep` and when it routes to `finish`
- How a budget check triggers compaction mid-turn
- Why compaction is a new turn on the _same_ thread, not a new thread
- How an interactive chat is just one turn, looped, waiting between runs

## The loop shape

_`respond` → `finish` (no tools) or loop (tools ran) or `compact` (over budget).
Example ref: `docs/examples/the-agent-loop/chat.ts#turn`._

## Budgets and compaction

_`compact` emits new `messages`, same thread — lighter, not reset.
TODO._

## Turn vs. response, precisely

_Reuse reference.md's Terms section definitions verbatim — locked terminology.
TODO._

## Building a chat from one turn

_`flow.use(agentTurn(persona))`, then `waitFor`/loop back, same thread throughout.
Example ref: `#chat`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Terms (Response/Turn), § Full examples #1 (agentTurn + chat).
**Examples:** `docs/examples/the-agent-loop/chat.ts` — regions: `turn`, `chat`. **Section:**
[Agents in practice](./README.md) **Prev / Next:**
[Tools and handlers](../describing-a-flow/tools-and-handlers.md) /
[Fan-out and joining](./fan-out-and-joining.md)
