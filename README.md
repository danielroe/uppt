# uppt

> A composite GitHub Action that turns conventional commits into a draft release PR, tags the PR on merge, and stages publishing to npm via OIDC trusted publishing.

The aim of **uppt** is to make a very simple, secure release workflow for maintainers which adheres to best security practices and doesn't require tokens or trusting a third-party GitHub App. It was extracted from scripts used in [nuxt/nuxt](https://github.com/nuxt/nuxt).

## Getting started

`uppt` is designed to be used with an opinionated set of security best practices. Here is how to use it.

### Set up your package for trusted publishing on npmjs.com

1. Visit `https://npmjs.com/package/<package-name>/access` and add a new trusted publisher entry, pointing at your repo and the `release.yml` workflow, with the `npm stage publish` permission chip.  Set the 'Environment name' to 'npm'. In a monorepo, repeat this once per published package, pointing each entry at the same workflow and environment.

> [!NOTE]
> [Staged publishing](https://docs.npmjs.com/staged-publishing/) requires you to approve the publish before it goes live.

> [!TIP]
> It is recommended also to set "Require two-factor authentication and disallow tokens."

![a screenshot of npmjs.com](https://raw.githubusercontent.com/danielroe/uppt/main/assets/trusted-publisher.png)

2. Create a [GitHub environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) named `npm`, and configure any restrictions on it (such as requiring approvals if you want). If you limit which refs can deploy to it, allow both `v*` and `release-*`: the publish job runs on the release tag, which is `vX.Y.Z` for lockstep and single-package repos but a `release-*` coordination tag in independent mode.
   ![a screenshot of github environment configuration settings](https://raw.githubusercontent.com/danielroe/uppt/main/assets/github-environments.png)

**3.** Allow GitHub Actions to create pull requests on your repo: under **Settings → Actions → General → Workflow permissions** (`https://github.com/<user>/<repo>/settings/actions`), check **Allow GitHub Actions to create and approve pull requests**. Without this, `uppt/pr` fails with `403 Forbidden: GitHub Actions is not permitted to create or approve pull requests` when opening the release PR.

**4.** Add the following workflow to your repo in `.github/workflows/release.yml`, and you're done!

> [!TIP]
> [`@e18e/setup-publish`](https://github.com/e18e/setup-publish) can scaffold this file for you. Run `npx @e18e/setup-publish` and pick the `uppt` template (interactive prompts will ask for your package manager and the GitHub environment name; pass `--env npm` to match the trusted-publisher entry from step 1).

```yaml
name: release

on:
  push:
    branches: [main]
  pull_request:
    types: [closed]
    branches: [main]
  # this is required to trigger releases when the release PR is merged, to
  # rerun a release if needed, or to cut a prerelease (run from the default
  # branch with `prerelease` set)
  workflow_dispatch:
    inputs:
      prerelease:
        description: 'Cut a prerelease instead of a normal release, e.g. `beta`, `rc`, or `0`'
        required: false
        default: ''

permissions: {}

jobs:
  # Parse commits since the last tag, push a `release/vX.Y.Z` branch, open
  # or update a draft release PR, and close any superseded release PRs
  # (e.g. `release/v1.0.1` when the bump is now `release/v1.1.0`).
  #
  # Also runs on a manual dispatch from a branch, which is how you cut a
  # prerelease. Manual dispatches on a `v*` tag are reruns of the publish
  # path below and skip this job.
  pr:
    if: |
      !github.event.repository.fork
      && (
        (
          github.event_name == 'push'
          && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
        ) || (
          github.event_name == 'workflow_dispatch'
          && !startsWith(github.ref, 'refs/tags/')
        )
      )
    runs-on: ubuntu-latest
    permissions:
      contents: write       # push the `release/vX.Y.Z` branch and delete superseded ones
      pull-requests: write  # create a release PR, update its body, close superseded PRs
    steps:
      - uses: danielroe/uppt/pr@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          prerelease: ${{ inputs.prerelease }}

  # The release PR was merged: tag the squash commit, cut a GitHub release
  # from the PR body, and dispatch the publish workflow. The `release/v`
  # head-ref guard keeps regular feature-PR merges from triggering this;
  # the head-repo guard keeps merged fork PRs from triggering it, and the
  # `repository.fork` guard keeps forks of this repo from releasing.
  release:
    if: |
      github.event_name == 'pull_request'
      && github.event.pull_request.merged == true
      && startsWith(github.event.pull_request.head.ref, 'release/v')
      && github.event.pull_request.head.repo.full_name == github.repository
      && !github.event.repository.fork
    runs-on: ubuntu-latest
    concurrency:
      group: release-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    permissions:
      contents: write       # push the `vX.Y.Z` tag and create the GitHub release
      actions: write        # `gh workflow run release.yml --ref vX.Y.Z` chained dispatch
    steps:
      - uses: danielroe/uppt/release@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  # The chained dispatch from `release` lands here as a `workflow_dispatch`
  # event on a `vX.Y.Z` tag ref. The `pack` job installs deps, runs
  # `pnpm pack` (or `npm pack`), and uploads the tarball as a workflow
  # artifact. See "Lifecycle scripts" below for what runs where. Manual
  # recovery uses the same path (Run workflow -> pick a `v*` tag).
  pack:
    if: github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    concurrency:
      group: pack-${{ github.ref }}
      cancel-in-progress: false
    permissions: {}
    outputs:
      files: ${{ steps.pack.outputs.files }}
    steps:
      - id: pack
        uses: danielroe/uppt/pack@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3

  # `publish` downloads the prebuilt tarball from the pack job's
  # artifact and stages it for publish.
  publish:
    if: |
      github.event_name == 'workflow_dispatch'
      && startsWith(github.ref, 'refs/tags/v')
      && needs.pack.outputs.files != '[]'
    needs: pack
    runs-on: ubuntu-latest
    concurrency:
      group: publish-${{ github.ref }}
      cancel-in-progress: false
    permissions:
      id-token: write       # OIDC claim for npm trusted publisher
    environment: npm        # must match the trusted-publisher entry on npmjs.com
    steps:
      - uses: danielroe/uppt/publish@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          files: ${{ needs.pack.outputs.files }}
```

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
| `packages` | _(unset)_ | Newline-separated list of publishable workspace directories (paths or globs, e.g. `packages/*`). When set, uppt operates in monorepo lockstep mode. See [Monorepo support](#monorepo-support). |
| `allow-forks` | `false` | Whether to run when the repository is a fork. By default the action skips (with a notice) so forks don't open release PRs of their own. |
| `prerelease` | _(unset)_ | One-shot prerelease identifier (`beta`, `rc`, or a bare number like `0`). From a stable version the normal bump is applied and the identifier attached at counter 0 (`4.5.2` → `5.0.0-beta.0`); from a prerelease with the same identifier the counter increments (`5.0.0-beta.0` → `5.0.0-beta.1`). When unset, a prerelease version graduates to its stable version (`5.0.0-beta.1` → `5.0.0`). |

### Creates a release (`danielroe/uppt/release`)

When you merge a release PR, this subaction tags that commit, creates a GitHub Release using the PR body as notes, then dispatches the publish workflow on the new tag.

| Input | Default | Description |
| --- | --- | --- |
| `token` | `${{ github.token }}` | GitHub token. Needs `contents: write` and `actions: write`. |
| `node-version` | `24` | Node version for the scripts. Needs `--experimental-strip-types` (Node 22.6+, 24+ recommended). |
| `publish-workflow` | `release.yml` | Workflow filename to dispatch after tagging. Must declare `workflow_dispatch`. |
| `checkout` | `true` | Set to `false` if the caller has already checked out `github.event.pull_request.merge_commit_sha`. |
| `mode` | `lockstep` | Monorepo versioning mode (`lockstep` or `independent`). Must match the value passed to `uppt/pr`. See [Independent versioning](#independent-versioning-experimental). |
| `allow-forks` | `false` | Whether to run when the repository is a fork. By default the action skips (with a notice) so forks don't tag and publish releases of their own. |

### Packs a tarball (`danielroe/uppt/pack`)

This subaction installs the package's dependencies, runs `pnpm pack --json` (if you have a `pnpm-lock.yaml`) or `npm pack --json`, and uploads each resulting `.tgz` as a workflow artifact for the `publish` job to consume. It exposes a `files` output (a JSON array of the produced tarball filenames) so the publish job can iterate them without re-scanning the artifact.

| Input | Default | Description |
| --- | --- | --- |
| `node-version` | `24` | Node version for the scripts. Needs `--experimental-strip-types` (Node 22.6+, 24+ recommended). Ignored when `install` is `false`. |
| `checkout` | `true` | Set to `false` if the caller has already checked out the tag ref. |
| `install` | `true` | Set to `false` to handle `actions/setup-node` and dependency installation yourself. Useful when you want a pinned package manager version, a cached `node_modules`, or a hardened install policy. When `false`, the caller must put `node`, `npm`, and any package manager on PATH before `uppt/pack` runs. |
| `packages` | _(unset)_ | Newline-separated list of publishable workspace directories (paths or globs). Must match the value passed to `uppt/pr`. See [Monorepo support](#monorepo-support). |
| `releases` | _(unset)_ | Independent-mode publish payload, from the workflow's `releases` dispatch input. Never set by hand. See [Independent versioning](#independent-versioning-experimental). |

| Output | Description |
| --- | --- |
| `files` | JSON array of tarball filenames produced by `npm pack` / `pnpm pack` (e.g. `["my-pkg-1.2.3.tgz"]`). Pass through to `uppt/publish` via its `files` input. |

### Stages a publish (`danielroe/uppt/publish`)

This subaction downloads the tarball uploaded by `uppt/pack` in the same workflow run and runs `npm stage publish ./<tarball>.tgz` with OIDC authentication. The staged version then needs to be approved by a maintainer with 2FA on npmjs.com before it goes live.

| Input | Default | Description |
| --- | --- | --- |
| `node-version` | `24` | Node version for the scripts and for `npm stage publish`. Needs `--experimental-strip-types` (Node 22.6+, 24+ recommended). |
| `npm-access` | `public` | npm access level (`public` or `restricted`). |
| `files` | _(scan artifact)_ | Optional JSON array of tarball filenames to publish, as emitted by `uppt/pack`'s `files` output. When omitted, every `*.tgz` in the downloaded artifact is published. |
| `releases` | _(unset)_ | Independent-mode publish payload, from the workflow's `releases` dispatch input. Never set by hand. See [Independent versioning](#independent-versioning-experimental). |

## Lifecycle scripts

uppt runs your package's lifecycle scripts at one specific point and skips them everywhere else. The aim is to keep the runner that produces the tarball from executing more third-party code than it has to.

- **During install** (inside `uppt/pack`): runs with `--ignore-scripts`. Your dependencies' `preinstall` / `install` / `postinstall` hooks do **not** fire, and neither does your own repo's `prepare`. This is deliberate: it's why a compromised transitive dependency can't run code on the publish runner. If your build genuinely needs a dependency's `postinstall` to have run, set `install: false` on `uppt/pack` and install yourself before the action runs.
- **During pack** (inside `uppt/pack`, after install): `prepack`, `prepare`, and `postpack` run. This is where your build belongs.
- **During publish** (inside `uppt/publish`): nothing runs. `prepublishOnly` is **not** invoked; the prebuilt tarball is published with `--ignore-scripts`. Move any logic you previously had in `prepublishOnly` into `prepack` so it runs during `uppt/pack` and the output lands in the tarball.

## Prereleases

The workflow above takes a `prerelease` input on manual dispatch, so to cut one you run the release workflow from your default branch and fill it in:

```bash
gh workflow run release.yml -f prerelease=beta
```

From `4.5.2` with a breaking change that opens a PR for `5.0.0-beta.0`. Run it again and you get `5.0.0-beta.1`; pass a different identifier and the counter resets (`5.0.0-rc.0`). A bare number gives you the `5.0.0-0` style instead. It's a one-shot input, not a mode: nothing is written down anywhere, so each run either continues the line you're already on or starts a new one.

The next push after a prerelease will create a PR for the next release (e.g. `5.0.0`). But if you want another prerelease, just run the workflow with `prerelease` set again and it'll be superseded by another prerelease PR.

## Monorepo support

uppt supports lockstep monorepos: every publishable package shares a single version, gets bumped together, lands under one `vX.Y.Z` tag, and is staged in one workflow run.

Declare the publishable workspaces by passing the same `packages:` input to `uppt/pr`, `uppt/release`, and `uppt/pack`. Each line is a directory path or a glob; `!`-prefixed entries are excluded; workspaces whose `package.json` has `"private": true` are silently skipped (even when listed by an exact path), so playgrounds and example apps stay out of npm.

```yaml
  pr:
    # ...
    steps:
      - uses: danielroe/uppt/pr@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          packages: |
            packages/*
            !packages/playground

  release:
    # ...
    steps:
      - uses: danielroe/uppt/release@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          packages: |
            packages/*
            !packages/playground

  pack:
    # ...
    steps:
      - uses: danielroe/uppt/pack@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          packages: |
            packages/*
            !packages/playground
```

The lockstep version comes from the workspaces themselves: every listed package must agree on a single semver `version`, and that's the version uppt bumps from. The root `package.json#version` (if present) is only bumped when it already matches the lockstep version, so a `0.0.0` or absent root version is left untouched.

> [!IMPORTANT]
> The `packages:` value on `uppt/pr`, `uppt/release`, and `uppt/pack` must match. If they diverge, the release PR, the tag, and the published tarballs will cover different sets of packages (and `uppt/release` will tag the wrong version: a private `0.0.0` root with no `packages:` input would otherwise be tagged `v0.0.0`).

> [!IMPORTANT]
> If you use pnpm, every workspace you list under `packages:` must also be listed in your `pnpm-workspace.yaml`. `pnpm pack` resolves `workspace:` and `catalog:` specifiers via the workspace graph, so a directory missing from `pnpm-workspace.yaml` will produce a tarball with unresolved specifiers (or fail outright).

### Independent versioning (experimental)

Lockstep is the wrong shape for some monorepos. If one package is on `0.8.0` and another is on `0.2.1`, you can set `mode: independent` alongside `packages:` and each package will advance versions on its own cadence.

Which package a commit belongs to comes from its conventional-commit scope. By default a package claims the last segment of its name, so `feat(kit):` bumps `@nuxt/kit` and `fix(fontaine):` bumps `fontaine`. If that isn't the scope you actually write, or two packages would claim the same one, you can configure this with `scopes:` on `uppt/pr`:

```yaml
          scopes: |
            @nuxt/kit: kit nuxt-kit
            @nuxt/schema: schema
```

Commits with no scope, or a scope that doesn't match a package (`docs:`, `feat(playground):`), don't bump anything.

Bumping a package also releases anything that depends on it. (Only `dependencies`, `peerDependencies` and `optionalDependencies` count.)

Instead of one `release/vX.Y.Z` PR you'll get a single `release/<base>-pending` PR covering every package with unreleased changes, with a section per package.

On merge, uppt tags each released package as `<name>@X.Y.Z` (`fontaine@0.9.0`, `@nuxt/kit@5.0.0`) on the merge commit, then creates one GitHub release on a `release-YYYY-MM-DD-<short-sha>` coordination tag rather than picking one package's tag to stand for the whole set. The publish workflow is dispatched on that coordination tag with a `releases` payload: a JSON array of `{ "name", "version", "dir" }`. `uppt/pack` packs exactly those workspaces, and `uppt/publish` stages them all, so they go live together when you approve them on npmjs.com.

Independent mode needs a few workflow changes on top of the lockstep setup: a `releases` dispatch input to carry the payload from the chained dispatch, `mode: independent` on `uppt/pr` and `uppt/release`, a looser head-ref guard (the PR branch is `release/<base>-pending`), and job conditions that accept the coordination tag. Here is the whole thing:

```yaml
name: release

on:
  push:
    branches: [main]
  pull_request:
    types: [closed]
    branches: [main]
  # this is required to trigger releases when the release PR is merged, to
  # rerun a release if needed, or to cut a prerelease (run from the default
  # branch with `prerelease` set)
  workflow_dispatch:
    inputs:
      prerelease:
        description: 'Cut a prerelease instead of a normal release, e.g. `beta`, `rc`, or `0`'
        required: false
        default: ''
      releases:
        description: 'Publish payload emitted by uppt/release; leave empty when rerunning a publish by hand'
        required: false
        default: ''

permissions: {}

jobs:
  # Work out which packages have unreleased changes, push a
  # `release/<base>-pending` branch bumping each of them, and open or update
  # a single draft release PR covering the lot.
  #
  # Also runs on a manual dispatch from a branch, which is how you cut a
  # prerelease. Manual dispatches on a tag are reruns of the publish path
  # below and skip this job.
  pr:
    if: |
      !github.event.repository.fork
      && (
        (
          github.event_name == 'push'
          && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
        ) || (
          github.event_name == 'workflow_dispatch'
          && !startsWith(github.ref, 'refs/tags/')
        )
      )
    runs-on: ubuntu-latest
    permissions:
      contents: write       # push the `release/vX.Y.Z` branch and delete superseded ones
      pull-requests: write  # create a release PR, update its body, close superseded PRs
    steps:
      - uses: danielroe/uppt/pr@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          prerelease: ${{ inputs.prerelease }}
          mode: independent
          packages: |
            packages/*

  # The release PR was merged: tag each released package, cut one GitHub
  # release on a coordination tag, and dispatch the publish workflow with
  # the list of packages to publish. The `release/` head-ref guard keeps
  # regular feature-PR merges from triggering this;
  # the head-repo guard keeps merged fork PRs from triggering it, and the
  # `repository.fork` guard keeps forks of this repo from releasing.
  release:
    if: |
      github.event_name == 'pull_request'
      && github.event.pull_request.merged == true
      && startsWith(github.event.pull_request.head.ref, 'release/')
      && github.event.pull_request.head.repo.full_name == github.repository
      && !github.event.repository.fork
    runs-on: ubuntu-latest
    concurrency:
      group: release-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    permissions:
      contents: write       # push the `<name>@X.Y.Z` tags and create the GitHub release
      actions: write        # chained dispatch of the publish run
    steps:
      - uses: danielroe/uppt/release@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          mode: independent
          packages: |
            packages/*

  # The chained dispatch from `release` lands here on the coordination tag,
  # carrying the `releases` payload. The `pack` job installs deps, packs each
  # listed workspace, and uploads the tarballs as a workflow artifact. See
  # "Lifecycle scripts" below for what runs where. Manual recovery uses the
  # same path (Run workflow -> pick a `release-*` or `v*` tag).
  pack:
    if: |
      github.event_name == 'workflow_dispatch'
      && (startsWith(github.ref, 'refs/tags/v') || startsWith(github.ref, 'refs/tags/release-'))
    runs-on: ubuntu-latest
    concurrency:
      group: pack-${{ github.ref }}
      cancel-in-progress: false
    permissions: {}
    outputs:
      files: ${{ steps.pack.outputs.files }}
    steps:
      - id: pack
        uses: danielroe/uppt/pack@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          releases: ${{ inputs.releases }}
          packages: |
            packages/*

  # `publish` downloads the prebuilt tarball from the pack job's
  # artifact and stages it for publish.
  publish:
    if: |
      github.event_name == 'workflow_dispatch'
      && (startsWith(github.ref, 'refs/tags/v') || startsWith(github.ref, 'refs/tags/release-'))
      && needs.pack.outputs.files != '[]'
    needs: pack
    runs-on: ubuntu-latest
    concurrency:
      group: publish-${{ github.ref }}
      cancel-in-progress: false
    permissions:
      id-token: write       # OIDC claim for npm trusted publisher
    environment: npm        # must match the trusted-publisher entry on npmjs.com
    steps:
      - uses: danielroe/uppt/publish@ac5677436f6aa3b06c98b811bd1e9ca0a768c90f # v0.6.3
        with:
          files: ${{ needs.pack.outputs.files }}
          releases: ${{ inputs.releases }}
```

When `releases` is empty every action behaves exactly as it does in lockstep mode, so rerunning a publish by hand on a `v*` tag still works.

> [!NOTE]
> Independent mode is new and hasn't been through many real releases yet. If something looks wrong, please open an issue.

> [!TIP]
> Every package needs its own trusted-publisher entry on npmjs.com, all pointing at the same `release.yml` and `npm` environment.

> [!IMPORTANT]
> Two things to check when switching an existing repo over. If your `npm` environment only allows `v*` tags to deploy, add `release-*`: independent-mode publishes run on the coordination tag, so a `v*`-only rule leaves the publish job waiting on an environment it can never enter. Tags are fine as they are, though. uppt reads `<name>@X.Y.Z`, so anything you've released by hand or with `bumpp --tag <name>@` is picked up as that package's last release, and a package with no tag of its own falls back to the newest `vX.Y.Z`, so the first independent run only releases what has actually changed.

## Prerequisites

For `pr` to work you need:

- **Allow GitHub Actions to create and approve pull requests** enabled under **Settings → Actions → General → Workflow permissions** (`https://github.com/<user>/<repo>/settings/actions`).

For `publish` to work end to end you need:

- An npmjs.com trusted-publisher entry per package, pointing at the caller's `release.yml` and the `npm` environment, with the `npm stage publish` permission chip.
- A GitHub environment named `npm` (or whichever name you put on the publish job). If you restrict which refs may deploy to it, allow `release-*` as well as `v*`, or independent-mode publishes will never get in.
- The package must already exist on npmjs.com; `npm stage publish` cannot stage a brand-new package. For the very first publish, [`setup-trusted-publishing`](https://github.com/ThisIsMissEm/setup-trusted-publishing) will publish a `0.0.0` stub so you can attach a trusted-publisher entry: `npx setup-trusted-publishing` (run once, from the package directory).

## Credits

Inspired by [unjs/changelogen](https://github.com/unjs/changelogen) and [antfu/changelogithub](https://github.com/antfu/changelogithub/).

There are also a number of other actions and workflows you might want to check out, including:

- [changesets](https://github.com/changesets/changesets)
- [release-please](https://github.com/googleapis/release-please)

## License

Made with ❤️

Published under [MIT License](./LICENCE).
