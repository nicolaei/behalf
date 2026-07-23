# Contributing

## Development

```bash
npm install
npm run verify
```

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

## First publish of a new package

npm's [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) can only be configured for a
package that already exists on the registry.
So a package's very first publish has to happen manually, once, before automation can take over for
it.

Do this once, in order (`core` has no `@behalf-js/*` dependencies; the other five all depend on it,
so it needs to exist on the registry first):

```bash
npm run build
(cd packages/core && npm publish)
(cd packages/testing && npm publish)
(cd packages/models-anthropic && npm publish)
(cd packages/models-openai && npm publish)
(cd packages/tools && npm publish)
(cd packages/stores && npm publish)
```

This uses your own npm login (`npm whoami` to check, `npm login` if not), not Trusted Publishing.
There's nothing to configure for it beyond having publish rights on the `@behalf-js` scope.

Once a package exists on the registry, register its Trusted Publisher so `release.yml` can publish
it automatically from then on: on npmjs.com, go to that package's **Settings → Trusted Publisher**
and add a GitHub Actions publisher with these values (the same six times, once per package):

| Field               | Value         |
| ------------------- | ------------- |
| Organization / user | `nicolaei`    |
| Repository          | `behalf`      |
| Workflow filename   | `release.yml` |
| Allowed actions     | `npm publish` |

Environment name can stay blank unless a GitHub Environment with required reviewers gets added later
as an extra approval gate.
