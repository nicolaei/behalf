---
"@behalf-js/models-anthropic": patch
---

Send another provider's thinking as text.

A session whose history was written by another provider (say, a model on OpenRouter) and is then resumed on Anthropic replayed that provider's thinking blocks as `thinking`.
Anthropic cannot verify their signature and rejected every request with a 400: "Invalid `signature` in `thinking` block" — the session was stuck for good.
Thinking from a non-Anthropic assistant turn now goes as plain text, and a block with no words is dropped.
