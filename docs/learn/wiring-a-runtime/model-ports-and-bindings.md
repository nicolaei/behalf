# Model ports and bindings

A `ModelPort` adapts one provider so the engine can call it; tool bindings are how a runtime
supplies real `ToolHandler`s for the tools your personas declare.

## You will learn

- What a `ModelPort` must implement, and what "it only responds" means (compaction is a normal
  response with a summary prompt)
- Why a port passes `thinking` blocks back unmodified
- What it converts when a thread crosses providers
- How to assemble tool bindings from `standardBindings` plus your own
- How this connects to `fakePort` for tests (forward ref to Setting up fakes)

## ModelPort

`ModelPort` is the seam between the engine and one specific provider: a `Model`, and one method that
turns a `Profile` plus a message history into the model's next `AssistantMessage`. reference.md's
[ModelPort](../../reference.md#modelport) entry has the exact interface; the shape that matters here
is one field and one method, `model` and `respond(profile, messages, stream)`.

"It only responds" means a port has no separate compaction, retry, or tool-loop logic of its own:
those are the engine's job (`context.compact`, `runtime()`'s `errorHandlers`, `agentTurn`'s loop).
A summarization turn is just another `respond` call, with a summary prompt in place of the user's
message, not a distinct code path.

Here's a small, real port with no external provider behind it: it echoes the last user message back
as text, and streams that text through `stream` as it goes.

```ts source=docs/examples/model-ports-and-bindings/sketch.ts#port
export function createEchoPort(model: Model): ModelPort {
  return {
    model,
    respond(_profile, messages, stream) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const text = lastUser?.content.find((block) => block.type === "text");
      const reply = text?.type === "text" ? `You said: ${text.text}` : "I didn't catch that.";

      stream.delta({ correlationId: "echo-reply", open: "text" });
      stream.delta({ correlationId: "echo-reply", text: reply });
      stream.delta({ correlationId: "echo-reply", close: true });

      return Promise.resolve({
        role: "assistant",
        provider: "echo",
        model: model.identifier,
        // Any thinking block already on the thread is forwarded exactly as it
        // arrived: mutating one, even just its text, breaks the token a
        // provider needs to accept it back on a later turn.
        content: [...priorThinking(messages), { type: "text", text: reply }],
        usage: { input: messages.length, output: 1 },
      });
    },
  };
}
```

Notice `respond` takes the full `messages` array, not just the latest one: a port always sees the
whole thread, since it's the one place that knows how to shape a request for its provider.
A real port (one calling an actual API) sends this same history across the wire; this one just reads
it in-process.

## Thinking blocks and retention

You might expect a port to strip a `thinking` block once the turn that produced it is over: it's
internal reasoning, not the reply.
Instead, a port passes every `thinking` block back unmodified, because retention is the provider's
decision, not the port's.
Some providers keep the full reasoning only as long as an opaque token on the block round-trips
unchanged; edit that token, even just the visible summary text next to it, and the provider rejects
it or silently drops the reasoning it was protecting.
A port that reshapes a block to "clean it up" breaks exactly the thing it's trying to preserve.
Here's the same `respond` implementation again, this time forwarding whatever `thinking` block
already sits on the thread untouched:

```ts source=docs/examples/model-ports-and-bindings/sketch.ts#thinking
      return Promise.resolve({
        role: "assistant",
        provider: "echo",
        model: model.identifier,
        // Any thinking block already on the thread is forwarded exactly as it
        // arrived: mutating one, even just its text, breaks the token a
        // provider needs to accept it back on a later turn.
        content: [...priorThinking(messages), { type: "text", text: reply }],
        usage: { input: messages.length, output: 1 },
      });
```

Cross-provider conversion is the one reshaping a port is still expected to do: if a thread's prior
`thinking` block came from a different model than the one now handling the turn, the new port
converts that block to plain `text` before sending it, since the new provider has no way to
interpret another provider's retention token. `respond`'s own signature never distinguishes "same
provider" from "different provider" traffic; that check, and the conversion it triggers, lives
inside whichever port is doing the converting.

> [!NOTE] `docs/reference.md`'s ModelPort section sketches two concrete adapters (Anthropic, OpenAI)
> to show how this plays out against two real APIs.
> Read those once you're implementing a port against an actual provider; the contract above is what
> any of them, including yours, has to satisfy.

## Tool bindings

A `Profile`'s `tools` field is a list of typed references, `name` and a schema, not implementations.
A binding is what supplies the implementation: `standardBindings` covers the filesystem and shell
tools the library ships (`read`, `write`, `edit`, `bash`); anything else, you provide yourself and
concatenate onto the same list.

```ts source=docs/examples/model-ports-and-bindings/sketch.ts#bindings
const lookupOrder = tool<{ orderId: string }, { status: string }>(
  "lookup_order",
  "Looks up an order's shipping status by id",
);

const lookupOrderBinding: Binding = provide(lookupOrder, ({ orderId }) =>
  Promise.resolve({ status: `order ${orderId} is in transit` }),
);

export const bindings: Binding[] = [...standardBindings, lookupOrderBinding];
```

`provide` pairs a `Tool` reference with its `ToolHandler`; the resulting list is exactly what
`runtime()`'s own `bindings` field expects, and exactly what `satisfiesFlows` checks a persona's
declared tools against.
A persona can declare `lookupOrder` without ever seeing `lookupOrderBinding`: the two only meet
inside the runtime that resolves them.

## Recap

- `ModelPort` is `model` plus `respond(profile, messages, stream)`; a port only responds, so
  compaction is just another response, not a separate code path
- A port passes `thinking` blocks back unmodified; retention is the provider's decision, and
  mutating a block risks breaking the token it round-trips on
- A port converts a `thinking` block to text only when the thread crosses to a different provider
- Tool bindings are `[...standardBindings, ...yourOwnBindings]`, built with `provide`
- Next: swap a real port for `fakePort` and run a flow against it in tests, in
  [Testing your flows](../testing/testing-your-flows.md)

---

**Reference:** reference.md § ModelPort (incl. the two provider sketches), § Tool bindings.
**Examples:** `docs/examples/model-ports-and-bindings/sketch.ts`, regions `port`, `bindings`.
**Section:** [Wiring a runtime](./README.md) **Prev / Next:** [Running flows](./running-flows.md) /
[Testing your flows](../testing/testing-your-flows.md)
