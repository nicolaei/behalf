# Streaming progress

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

`openStream` lets a step or a tool handler broadcast partial progress before anything is committed
to the log — the same mechanism a model call uses internally for its own streamed text.

## You will learn

- How `openStream(type)` opens a fresh, logged stream scoped to the current thread
- The `delta`/`commit`/`abort` lifecycle of a `Stream`
- How a slow tool (e.g. `search_files`) reports progress this way
- How this relates to a model call's own internal stream

## Opening a stream

_`context.openStream(type)` / `ToolContext.openStream(type)`.
Example ref: `docs/examples/streaming-progress/search-files.ts#open-stream`._

## delta, commit, abort

_`delta` broadcasts, not persisted; `commit` finalizes into the log; `abort` commits what streamed,
marks `aborted: true`.
Example ref: `#lifecycle`._

## A slow tool reporting progress

_A `search_files`-style handler streaming partial hits.
Example ref: `#slow-tool`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § StepContext (openStream), § Session store (Stream, Event/Envelope
delta form). **Examples:** `docs/examples/streaming-progress/search-files.ts` — regions:
`open-stream`, `lifecycle`, `slow-tool`. **Section:** [Streaming and sessions](./README.md) **Prev /
Next:** [Evaluating personas](../testing/evaluating-personas.md) /
[Sessions and the gateway](./sessions-and-the-gateway.md)
