# Messages and content

A thread is a list of `Message`s, and every message is a role plus an array of content blocks.
This page is the vocabulary the rest of the docs assume you already have.

## You will learn

- Tell the four message roles apart and what each carries
- Recognize the five content block kinds, especially `thinking` and `toolCall`/`toolResult`
- Why a `thinking` block's `signature` must round-trip unmodified
- What `intent` means: `standard`, `steering`, `abort`
- How `kind` routes `waitFor`/`interrupt`

## Roles and content blocks

A `Message` has one of four roles, and each carries the same shape: an array of `ContentBlock`s.
`system` sets the persona's instructions; `user` carries input from outside the flow; `assistant` is
the model's own reply; `tool` carries the results of whatever the assistant called.

The example below builds one of each, using four of the five content block kinds along the way:
`text` on every message, `image` on the user's, `toolCall` on the assistant's, and `toolResult` on
the tool message that answers it.

```ts source=docs/examples/messages-and-content/basic.ts#message
export const systemMessage: Message = {
  role: "system",
  content: [{ type: "text", text: "You are a support triage agent." }],
};

export const userMessage: Message = {
  role: "user",
  intent: "standard",
  content: [
    { type: "text", text: "My invoice total looks wrong, see the screenshot." },
    { type: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAUA" },
  ],
};

export const assistantMessage: Message = {
  role: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5",
  usage: { input: 42, output: 18 },
  content: [
    { type: "text", text: "Let me check that invoice." },
    { type: "toolCall", correlationId: "call-1", name: "lookup_invoice", input: { id: "INV-204" } },
  ],
};

export const toolMessage: Message = {
  role: "tool",
  content: [
    { type: "toolResult", correlationId: "call-1", output: { total: 84.5, currency: "USD" } },
  ],
};
```

Notice `correlationId`: the assistant's `toolCall` and the tool message's `toolResult` share the
same one.
That's the pairing the engine uses to match a call to its answer; nothing else on either block ties
them together.

## Thinking blocks and the signature

A `thinking` block is the model's own reasoning, persisted on the assistant message and sent back on
the next call exactly as it arrived.
Some providers put the full reasoning in `signature`, an opaque round-trip token, and leave `text`
empty or just a short summary; others put a readable summary in `text` and use `signature` for their
own bookkeeping.
Either way, a `ModelPort` never edits a thinking block it's replaying: mutating one invalidates its
signature, and the next request to that provider fails.
Here's an assistant message carrying a thinking block alongside its visible reply:

```ts source=docs/examples/messages-and-content/basic.ts#thinking-block
export const assistantWithThinking: Message = {
  role: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5",
  usage: { input: 50, output: 30, reasoning: 12 },
  content: [
    {
      type: "thinking",
      text: "Checking whether the invoice's tax line matches the customer's region.",
      signature: "opaque-round-trip-token",
    },
    { type: "text", text: "The tax line is correct for a California customer." },
  ],
};
```

You might expect an empty `text` field to mean the block is broken or worth dropping, but it's
neither: `signature` is where the reasoning actually lives when a provider doesn't expose it as
readable text.
Treat `signature` as opaque data to carry, not a field to inspect or edit.

> [!NOTE] A port does strip or convert thinking blocks when a thread crosses to a different
> provider, since one provider's token means nothing to another's API.
> That conversion is the port's job, not something a flow author writes by hand.

## Intent and kind

A user message carries `intent`, one of `standard`, `steering`, or `abort`. `standard` is an
ordinary message, waited for and processed like any input. `steering` arrives mid-turn and is folded
into the step already in flight, instead of waiting for the turn to end. `abort` cancels the current
turn outright.

`kind` is a separate, optional label: the routing tag `waitFor` and `interrupt` match on.
Here's a steering message that sets both `intent` and a `kind` a `waitFor` node listens for:

```ts source=docs/examples/messages-and-content/basic.ts#user-message
export const steeringMessage: UserMessage = {
  role: "user",
  intent: "steering",
  kind: "follow-up",
  content: [{ type: "text", text: "Actually, check the tax line too." }],
};
```

`kind` is a string you choose, not an API name: `"follow-up"`, `"human-reply"`, `"approval"` are all
just labels a `waitFor(userInput(kind))` node somewhere is listening for.
A standard message and a steering one can carry the same `kind`; only `intent` changes how the
engine times its arrival.

## Recap

- A `Message` is a role (`system`/`user`/`assistant`/`tool`) plus an array of `ContentBlock`s
- The five block kinds are `text`, `thinking`, `image`, `toolCall`, and `toolResult`
- A `toolCall` and its `toolResult` share a `correlationId`, the only thing that pairs them
- A `signature` on a `thinking` block is opaque data to carry unmodified, not a field to inspect
- `intent` (`standard`/`steering`/`abort`) controls timing; `kind` is a routing label `waitFor` and
  `interrupt` match on
- Next: the persona that sends and receives these messages, in
  [Profiles and models](./profiles-and-models.md)

---

**Reference:** reference.md § Message (full block). **Examples:**
`docs/examples/messages-and-content/basic.ts`, regions `message`, `user-message`, `thinking-block`.
**Section:** [Describing a flow](./README.md) **Prev / Next:**
[Waiting and interrupts](../building-the-graph/waiting-and-interrupts.md) /
[Profiles and models](./profiles-and-models.md)
