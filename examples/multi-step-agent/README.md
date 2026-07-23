# multi-step-agent

An Ink TUI example built on `behalf` demonstrating a four-stage agent pipeline: **asker → red →
green → refactor**.

## What it demonstrates

- **`agentTurn`'s `finishOn` option** — the asker's turn ends the instant it calls `submit_spec`,
  instead of the default "no tool calls left" rule.
- **`threadAction: "new"` edge chaining** — each stage (asker, red, green, refactor) runs its own
  `agentTurn` on a brand-new thread.
  A stage's model never sees the previous stage's own tool-call chatter, only a `prompt` transform
  carrying its predecessor's own structured result forward.
- **A UI-bound tool (`ask`)** — the asker interviews the user through an `ask` tool whose "binding"
  resolves through a tiny pub/sub bridge (`ask-bridge.ts`) instead of real I/O; the UI renders it as
  an inline text-input card, not a generic tool card.

## How it's wired

```
asker (agentTurn, finishOn submit_spec)
  --[threadAction: "new", prompt: reportOf(asker)]--> red (agentTurn)
  --[threadAction: "new", prompt: reportOf(red)]--> green (agentTurn)
  --[threadAction: "new", prompt: reportOf(green)]--> refactor (agentTurn)
```

- **asker** — interviews the user via `ask` (1-3 clarifying questions), then calls `submit_spec`
  once it has a page name + description.
- **red** — writes ONE failing test for that spec (`write_file` + `run_bash` to confirm it's red),
  does not implement anything.
- **green** — makes the failing test pass with the smallest real implementation, confirms it's
  green.
- **refactor** — improves structure while keeping tests green, reports the final diff.

Each stage shares the same write-capable filesystem tools (`write_file`, `edit_file`, `run_bash` —
real `node:fs/promises` / `node:child_process` I/O, not a sandbox) defined in `src/tools/fs.ts`.

## Running it

```sh
npm install
npm start
```

Type your opening message (e.g. "I want a page for tracking book recommendations") into the input
box at the bottom — that's the only thing the free-text input is wired to.
It seeds the whole pipeline via `runFlow`.
From there, the asker's clarifying questions appear as inline `ask` cards; answer them there.
Everything after the asker stage runs autonomously (red → green → refactor) with tool calls rendered
as cards in the transcript, and a `── stage ──` banner marking each stage boundary.

Requires a real Anthropic API key or Claude Code OAuth session — see `behalf`'s own
`adapters.models.createAnthropicPort` for auth resolution.
