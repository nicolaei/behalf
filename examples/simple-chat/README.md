# simple-chat

A real, runnable Ink TUI chat agent built on `behalf`.
It uses a real Anthropic model port with real token-by-token streaming and real
filesystem tools — no mocks, no fixtures.
It exists as a working example of wiring `behalf`'s engine (`runtime`, `defineGraph`,
tools, streaming) into an actual terminal UI.

## Running it

`behalf` is linked into this example via `file:../..`, so build the library first.

```sh
# from the repo root
npm install
npm run build

# from examples/simple-chat/
cd examples/simple-chat
npm install
npm start
```

### Auth

The Anthropic adapter needs one of two credentials, checked in this order:

- `CLAUDE_CODE_OAUTH_TOKEN` — the same OAuth token `pi`/Claude Code itself uses.
  Get one with `claude setup-token`.
- `ANTHROPIC_API_KEY` — a plain API key.

If both are set, the OAuth token wins (see `resolveAuth` in
`../../src/adapters/models/anthropic.ts`).
Neither present is a hard error at startup, not a silent no-op.

### `npm run m1`

A non-interactive one-shot smoke test: one model call, no tools, no UI loop.
Useful for a quick "is auth/wiring working at all?" check without launching the
full TUI.

```sh
npm run m1
```

## How it's wired

```
index.tsx          runtime() setup: model port, filesystem bindings, error
                    handlers, in-memory store. Renders <App> once the runtime
                    resolves.
      ↓
chat.ts             the graph: agentLoop (behalf's own reusable graph — run
                    the model, wait for every tool call it made, fold their
                    results into one message, loop until a reply uses no
                    tools) → chat (loops agentLoop, waiting for the next
                    user prompt between turns, same thread throughout).
      ↓
App.tsx             the UI: folds the store's committed envelopes into a
                    scrolling transcript (messages, tool calls/results), and
                    layers live "delta" envelopes on top for in-flight
                    streaming (the model's own reply, and a slow tool's own
                    progress).
```

- `index.tsx` also supplies `rateLimitBackoff` (`retry.ts`) as the first error
  handler: a realistic `Retry-After`-aware backoff for real provider rate
  limits, ahead of `behalf`'s own tiny-delay `defaultErrorHandler`. The
  classification itself ("was this actually a 429/5xx") lives in `behalf`'s
  own Anthropic adapter (`isRetryableAnthropicError`), which throws a
  `RetryableError` — `rateLimitBackoff` only decides how long to wait.
- Tool errors are left to reject naturally; the engine's tool executor turns a
  rejected handler promise into the run's error path — the tools in
  `tools.ts` never hand-roll a synthetic `{ isError }`.

## Tools

| Tool | What it does |
| --- | --- |
| `read` | Read a UTF-8 text file from disk. |
| `list_directory` | List a directory's entries. |
| `cwd` | Return the process's current working directory. |
| `search_files` | Recursively search files under a directory for a substring match. Streams its own progress while it runs (see below). |

## Streaming, in plain language

Two different things stream, over the same underlying mechanism
(`Delta` envelopes via `store.changes()`), just applied to different
correlation ids:

- The model's own reply streams token-by-token as it's generated (M4) — the
  assistant's text grows live in the transcript instead of appearing all at
  once when the call finishes.
- `search_files` is a deliberately slow tool: it streams a progress line
  ("scanned N/M files…") on its own `correlationId` while it walks the
  directory tree (M5), so a long search shows visible progress on its tool
  card instead of looking stalled.

`App.tsx` subscribes to `ready.store.changes()` once and routes each delta by
what it matches: a `text` delta with no matching tool card updates the live
assistant reply; a delta whose `correlationId` matches an open tool card
updates that card's progress line instead.

Thinking (reasoning) content the model produces is never dumped into the
transcript — a message with thinking blocks shows one collapsed, dimmed
line (`💭 (thinking, N chars)`) instead of the raw reasoning text.
