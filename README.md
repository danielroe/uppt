# uppt

> A composite GitHub Action that turns conventional commits into a draft release PR, tags the PR on merge, and stages publishing to npm via OIDC trusted publishing.

The aim of **uppt** is to make a very simple, secure release workflow for maintainers which adheres to best security practices and doesn't require tokens or trusting a third-party GitHub App. It was extracted from scripts used in [nuxt/nuxt](https://github.com/nuxt/nuxt).

## Getting started

`uppt` is designed to be used with an opinionated set of security best practices. Here is how to use it.

### Set up your package for trusted publishing on npmjs.com

1. Visit `https://npmjs.com/<package-name>/settings` and add a new trusted publisher entry, pointing at your repo and the `release.yml` workflow, with the `npm stage publish` permission chip.  Set the 'Environment name' to 'npm'.

> [!NOTE]
> [Staged publishing](https://docs.npmjs.com/staged-publishing/) requires you to approve the publish before it goes live.

> [!TIP]
> It is recommended also to set "Require two-factor authentication and disallow tokens."

![a screenshot of npmjs.com](https://raw.githubusercontent.com/danielroe/uppt/main/assets/trusted-publisher.png)

2. Create a [GitHub environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) named `npm`. You can scope it to `v*` tags, and configure any restrictions on it (such as requiring approvals if you want).
   ![a screenshot of github environment configuration settings](https://raw.githubusercontent.com/danielroe/uppt/main/assets/trusted-publisher.png)

**3.** Add the following workflow to your repo in `.github/workflows/release.yml`, and you're done!

```yaml
name: release

on:
  push:
    branches: [main]
  pull_request_target:
    types: [closed]
    branches: [main]
  # this is required to trigger releases when the release PR is merged, or to rerun a release if needed
  workflow_dispatch:

permissions: {}

jobs:
  # Parse commits since the last tag, push a `release/vX.Y.Z` branch, open
  # or update a draft release PR, and close any superseded release PRs
  # (e.g. `release/v1.0.1` when the bump is now `release/v1.1.0`).
  pr:
    if: github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    permissions:
      contents: write       # push the `release/vX.Y.Z` branch and delete superseded ones
      pull-requests: write  # create a release PR, update its body, close superseded PRs
    steps:
      - uses: danielroe/uppt/pr@02a45b8fc28aebb98abf0612ba44e2a4cbb612fd # v0.3.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  # The release PR was merged: tag the squash commit, cut a GitHub release
  # from the PR body, and dispatch the publish workflow. The `release/v`
  # head-ref guard keeps regular feature-PR merges from triggering this.
  release:
    if: |
      github.event_name == 'pull_request_target'
      && github.event.pull_request.merged == true
      && startsWith(github.event.pull_request.head.ref, 'release/v')
    runs-on: ubuntu-latest
    permissions:
      contents: write       # push the `vX.Y.Z` tag and create the GitHub release
      actions: write        # `gh workflow run release.yml --ref vX.Y.Z` chained dispatch
    steps:
      - uses: danielroe/uppt/release@02a45b8fc28aebb98abf0612ba44e2a4cbb612fd # v0.3.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  # The chained dispatch from `release` lands here as a `workflow_dispatch`
  # event on a `vX.Y.Z` tag ref. Manual recovery uses the same path
  # (Run workflow -> pick a `v*` tag).
  publish:
    if: github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: read        # checkout the tag
      id-token: write       # OIDC claim for npm trusted publisher
    environment: npm        # must match the trusted-publisher entry on npmjs.com
    steps:
      - uses: danielroe/uppt/publish@02a45b8fc28aebb98abf0612ba44e2a4cbb612fd # v0.3.0
```

> [!IMPORTANT]
> Once you add this workflow, it is strongly recommended to run `npx pin-github-action .github/workflows/release.yml` to pin each subaction's version to a SHA.

### Is `pull_request_target` safe here?

`pull_request_target` is a well-known footgun, but is used safely in this action:

- It checks out the squash commit on the default branch, not the PR.
- It does not install dependencies or run anything from the codebase being released.
- It reads a single value from the codebase - `package.json#version` - which is validated against a strict semver regex.
- All subprocess calls use `execFileSync` with argv arrays, and the generated PR body is passed as an env var and forwarded to `gh release create --notes` as a single arg.

## What it does

### Creates a PR (`danielroe/uppt/pr`)

Whenever you push to the default branch, this action parses conventional commits since the latest semver tag, decides the next bump (major, minor or patch) and creates a `release/vX.Y.Z` branch with the version bump, and opens or updates a draft PR against the base branch.

> [!TIP]
> You can edit this PR to add your own release notes. Anything above `## 👉 Changelog` is preserved when the changelog is updated.

| Input | Default | Description |
| --- | --- | --- |
| `token` | `${{ github.token }}` | GitHub token. Needs `contents: write` and `pull-requests: write`. |
| `base-branch` | default branch | Base branch for the release PR. |
| `node-version` | `24` | Node version for the scripts. Needs `--experimental-strip-types` (Node 22.6+, 24+ recommended). |
| `checkout` | `true` | Set to `false` if the caller has already checked out with `fetch-depth: 0`. |

### Creates a release (`danielroe/uppt/release`)

When you merge a release PR, this subaction tags that commit, creates a GitHub Release using the PR body as notes, then dispatches the publish workflow on the new tag.

| Input | Default | Description |
| --- | --- | --- |
| `token` | `${{ github.token }}` | GitHub token. Needs `contents: write` and `actions: write`. |
| `node-version` | `24` | Node version for the scripts. Needs `--experimental-strip-types` (Node 22.6+, 24+ recommended). |
| `publish-workflow` | `release.yml` | Workflow filename to dispatch after tagging. Must declare `workflow_dispatch`. |
| `checkout` | `true` | Set to `false` if the caller has already checked out `github.event.pull_request.merge_commit_sha`. |

### Stages a publish (`danielroe/uppt/publish`)

This subaction runs `pnpm pack` (if you have a `pnpm-lock.yaml`) and then runs `npm stage publish` with OIDC authentication. The staged version then needs to be approved by a maintainer with 2FA on npmjs.com before it goes live.

| Input | Default | Description |
| --- | --- | --- |
| `node-version` | `24` | Node version for the scripts and for `npm stage publish`. Needs `--experimental-strip-types` (Node 22.6+, 24+ recommended). |
| `npm-access` | `public` | npm access level (`public` or `restricted`). |
| `checkout` | `true` | Set to `false` if the caller has already checked out the tag ref. |

## Prerequisites

For `publish` to work end to end you need:

- An npmjs.com trusted-publisher entry per package, pointing at the caller's `release.yml` and the `npm` environment, with the `npm stage publish` permission chip.
- A GitHub environment named `npm` (or whichever name you put on the publish job).
- The package must already exist on npmjs.com; `npm stage publish` cannot stage a brand-new package.

## Credits

Inspired by [unjs/changelogen](https://github.com/unjs/changelogen) and [antfu/changelogithub](https://github.com/antfu/changelogithub/).

There are also a number of other actions and workflows you might want to check out, including:

- [changesets](https://github.com/changesets/changesets)
- [release-please](https://github.com/googleapis/release-please)

## License

Made with ❤️

Published under [MIT License](./LICENCE).
