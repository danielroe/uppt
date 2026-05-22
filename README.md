# uppt

A composite GitHub Action that turns conventional commits into a draft release PR, tags the PR on merge, and stages publishing to npm via OIDC trusted publishing.

## Usage

```yaml
name: release

on:
  push:
    branches: [main]
  pull_request_target:
    types: [closed]
    branches: [main]
  # Required: `release` mode chains into `publish` via `gh workflow run`, which
  # fires `workflow_dispatch`. Also serves as the manual publish-recovery entry point.
  workflow_dispatch:

permissions: {}

jobs:
  # `pr` mode: parse commits since the last tag, push a `release/vX.Y.Z`
  # branch, open or update a draft release PR, and close any superseded
  # release PRs (e.g. `release/v1.0.1` when the bump is now `release/v1.1.0`).
  pr:
    if: github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    permissions:
      contents: write       # push the `release/vX.Y.Z` branch and delete superseded ones
      pull-requests: write  # create a release PR, update its body, close superseded PRs
    steps:
      - uses: danielroe/uppt@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  # `release` mode: the release PR was merged. Tag the squash commit, cut a
  # GitHub release from the PR body, dispatch the publish workflow. The
  # `release/v` head-ref guard is what keeps regular feature-PR merges from
  # triggering a tag attempt.
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
      - uses: danielroe/uppt@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  # `publish` mode: the chained dispatch from `release` lands here as a
  # `workflow_dispatch` event on a `vX.Y.Z` tag ref. Manual recovery uses
  # the same path (Run workflow -> pick a `v*` tag).
  publish:
    if: github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: read        # checkout the tag
      id-token: write       # OIDC claim for npm trusted publisher
    environment: npm        # matches the trusted-publisher entry on npmjs.com
    steps:
      - uses: danielroe/uppt@v1
        with:
          mode: publish
```

### Is `pull_request_target` safe here?

`pull_request_target` is the well-known footgun: it runs in the target branch's context, with write permissions and access to secrets, and the classic exploit is checking out the PR head and running build or test scripts from attacker-controlled code.

The `release` job avoids that pattern. Concretely:

- It checks out `github.event.pull_request.merge_commit_sha` (the squash commit on the default branch, created after the maintainer approved and clicked merge). It never checks out `head.sha`.
- It does not run `npm install`, `pnpm install`, `postinstall`, or any build / test scripts from the merged code. The only thing it executes is `node scripts/tag-and-release.ts` from `${{ github.action_path }}`, which is this action's pinned checkout, not the consumer repo's.
- The single value it reads from the merged code is `package.json#version`, and it is validated against a strict semver regex before flowing into `git tag` / `gh` argv. Flag-injection (`--upload-pack=...`) and ref-confusion attacks are blocked at that gate.
- All subprocess calls use `execFileSync` with argv arrays, never `execSync` or shell interpolation. `PR_BODY` is passed as an env var and forwarded to `gh release create --notes` as a single argv, so backtick / `$()` content in a PR body is inert.

In short: the only attacker-controlled input that reaches a subprocess is the semver-validated package version, passed argv-not-shell.

## What it does

- **`pr`** (push to default branch): parses conventional commits since the latest semver tag, decides the next bump (`major` / `minor` / `patch`), pushes a `release/vX.Y.Z` branch with the version bump as `github-actions[bot]`, and opens or updates a draft PR against the base branch. The PR body uses `## 👉 Changelog` as a marker; text above the marker is preserved across updates. If a subsequent commit shifts the target version (e.g. a `feat:` lands after a patch PR was opened), the stale PR is closed, its branch deleted, and its preamble carried into the new PR. Superseded-PR cleanup is scoped to the same base branch, so a repo with maintenance branches (e.g. `main`, `4.x`, `3.x`) can have a release PR open against each one without them clobbering each other.
- **`release`** (`pull_request_target: closed` from a merged PR): reads the version from `package.json` at the merge commit, tags that commit, creates a GitHub Release using the PR body as notes, then dispatches the publish workflow on the new tag.
- **`publish`** (`push: tags: ['v*']`, `workflow_dispatch` on a tag): if `pnpm-lock.yaml` is present, runs `pnpm pack` (so `catalog:` specifiers resolve) then `npm stage publish ./<tarball>.tgz --provenance --access <access>`. Otherwise runs `npm stage publish --provenance --access <access>` from source. Always `npm stage publish`, never `npm publish`. OIDC trusted publishing, no `NPM_TOKEN`. The maintainer approves the staged version with 2FA on npmjs.com afterwards.

Mode is auto-detected from `github.event_name` by default; set `mode:` explicitly to override.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `pr`, `release`, or `publish`. |
| `token` | `${{ github.token }}` | Required for `release`; recommended for `pr`. Not used by `publish`. |
| `base-branch` | default branch | Base branch for the release PR. |
| `node-version` | `24` | Node version used for the scripts and for `publish`. Needs to support `--experimental-strip-types` (Node 22.6+, 24+ recommended). |
| `npm-access` | `public` | npm access level (`public` or `restricted`). |
| `publish-workflow` | `release.yml` | Workflow filename to dispatch after tagging. Must declare `workflow_dispatch`. |
| `checkout` | `true` | Set to `false` if the caller has already checked out the right ref. |

## Prerequisites

For `publish` to work end to end you need:

- An npmjs.com trusted-publisher entry per package, pointing at the caller's `release.yml` and the `npm` environment, with the `npm stage publish` permission chip.
- A GitHub environment named `npm` (or whichever name you put on the publish job).
- The package must already exist on npmjs.com; `npm stage publish` cannot stage a brand-new package.

## License

[MIT](./LICENSE)
