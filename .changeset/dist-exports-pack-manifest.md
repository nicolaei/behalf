---
"@behalf-js/core": patch
"@behalf-js/engine": patch
"@behalf-js/testing": patch
"@behalf-js/models-anthropic": patch
"@behalf-js/models-openai": patch
"@behalf-js/tools": patch
"@behalf-js/stores": patch
---

Resolve package entry points to source in the workspace, dist in the tarball.

Every package's `exports` now points at `./src/*.ts` in the checkout, so in-repo consumers — this
workspace's tests and cockpit's `file:` dependencies — need no build step. `prepack`/`postpack` run
a new `tools/pack-manifest.mjs` to swap those entries to `{ types, default }` dist objects while
packing, and back to source afterward, so published tarballs still ship compiled `./dist` output.
