---
"@behalf-js/models-anthropic": patch
---

Raise `CLAUDE_CODE_VERSION` from `2.1.75` to `2.1.280`.

The API gates OAuth traffic per model by the version in the request's user-agent: `claude-opus-5-5`
rejects anything below `2.1.280` with `400 invalid_request_error` /
`error_code "claude_code_version_too_old"`, and answers `200` once the user-agent reports `2.1.280`.
`2.1.280` is both the minimum the API names and the version the working client on this machine
announces, so the constant cannot be lowered without bringing the refusal back. The beta flags, the
identity block and the tool surface are unchanged.
