# Contributing

## Development

```bash
npm ci
```

Setup is `npm ci` in this checkout and `npm ci` in the sibling `cockpit` checkout.
Neither needs a build: in-repo consumers — this workspace's tests, and cockpit through its `file:`
links — resolve each package's `src` directly.
Never copy one checkout's files, `node_modules` or `dist` over another, and never run `git restore`
or `git checkout` while unsure which worktree `.git` points at: a session's worktree belongs only to
it.
If setup is missing, run `npm ci` in your own checkout.

`npm run verify` is the one command that has to pass before a change is done: build, format, lint,
typecheck (including `docs/examples/` and both `examples/*` apps), and test.

## Versioning and releasing

behalf ships as six packages under `@behalf-js/*` (`core`, `testing`, `models-anthropic`,
`models-openai`, `tools`, `stores`), versioned together with
[Changesets](https://github.com/changesets/changesets).
They're a fixed group: bumping one bumps all six to the same version, because `core` is effectively
a peer dependency of the other five, and independent versioning would create a compatibility matrix
nobody needs at this stage.

Add a changeset for any change that should land in the next release:

```bash
npm run changeset
```

Every changeset is classified `patch` for now, regardless of how large the change actually is.
This isn't a special convention invented for this repo.
It's semver's own rule for major version zero: "anything may change at any time." behalf will start
using `minor` and `major` once it reaches `1.0.0`.

Merging a PR with a pending changeset opens (or updates) a "Version Packages" PR via
[`release.yml`](.github/workflows/release.yml); merging that PR publishes the new versions to npm.
