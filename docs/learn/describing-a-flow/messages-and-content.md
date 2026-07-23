# Messages and content

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

Every turn is built from `Message`s and their content blocks — this page is the vocabulary the rest
of the docs assume you already have.

## You will learn

- The four message roles and what each carries
- The five content block kinds, especially `thinking` and `toolCall`/`toolResult`
- Why a `thinking` block's `signature` must round-trip unmodified
- What `intent` means: `standard`, `steering`, `abort`
- How `kind` routes `waitFor`/`interrupt`

## Roles and content blocks

_system/user/assistant/tool, `ContentBlock` union.
Example ref: `docs/examples/messages-and-content/basic.ts#message`._

## Thinking blocks and the signature

_Why `text` can be empty for some providers (the full thinking is encrypted into `signature`
instead), why a port never mutates one — reasoned generically, no provider named (see
style-guide.md's provider-naming rule).
TODO._

## Intent and kind

_`standard`/`steering`/`abort`; `kind` as the routing label.
Example ref: `#user-message`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Message (full block). **Examples:**
`docs/examples/messages-and-content/basic.ts` — regions: `message`, `user-message`,
`thinking-block`. **Section:** [Describing a flow](./README.md) **Prev / Next:**
[Waiting and interrupts](../building-the-graph/waiting-and-interrupts.md) /
[Profiles and models](./profiles-and-models.md)
