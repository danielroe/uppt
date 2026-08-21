# uppt

> A composite GitHub Action that turns conventional commits into a draft release PR, tags the PR on merge, and stages publishing to npm via OIDC trusted publishing.

The aim of **uppt** is a simple, secure release workflow that doesn't require tokens or trusting a third-party GitHub App. It was extracted from scripts used in [nuxt/nuxt](https://github.com/nuxt/nuxt).

## Getting started

1. **Set up trusted publishing on npmjs.com.** Visit `https://npmjs.com/package/<package-name>/access` and add a trusted publisher pointing at your repo and the `release.yml` workflow, with the `npm stage publish` permission chip and 'Environment name' set to `npm`. In a monorepo, repeat once per published package.

   The package must already exist on npm; for a brand-new package, `npx setup-trusted-publishing` ([docs](https://github.com/ThisIsMissEm/setup-trusted-publishing)) publishes a `0.0.0` stub you can attach the entry to.

> [!NOTE]
> [Staged publishing](https://docs.npmjs.com/staged-publishing/) means you approve each publish (with 2FA) before it goes live. It's also recommended to set "Require two-factor authentication and disallow tokens."

   <details>
   <summary>Screenshot</summary>

   ![a screenshot of npmjs.com](https://raw.githubusercontent.com/danielroe/uppt/main/assets/trusted-publisher.png)
   </details>

2. **Create a [GitHub environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) named `npm`**, with whatever restrictions you like (such as required approvals). If you limit which refs can deploy to it, allow both `v*` and `release-*` tags.

   <details>
   <summary>Screenshot</summary>

   ![a screenshot of github environment configuration settings](https://raw.githubusercontent.com/danielroe/uppt/main/assets/github-environments.png)
   </details>

3. **Allow GitHub Actions to create pull requests**: check **Allow GitHub Actions to create and approve pull requests** under **Settings → Actions → General → Workflow permissions**. Without it, `uppt/pr` won't be able to open the release PR.

4. **Add the workflow** below as `.github/workflows/release.yml`, and you're done!

> [!TIP]
> [`@e18e/setup-publish`](https://github.com/e18e/setup-publish) can scaffold this file: run `npx @e18e/setup-publish` and pick the `uppt` template (pass `--env npm` to match step 1).

```yaml
name: release

on:
  push:
    branches: [main]
  pull_request:
    types: [closed]
    branches: [main]
  # merged release PRs, publish reruns, and prereleases all arrive here
  workflow_dispatch:
    inputs:
      prerelease:
        description: 'Cut a prerelease instead of a normal release, e.g. `beta`, `rc`, or `0`'
        required: false
        default: ''

permissions: {}

jobs:
  # open or update a draft release PR from conventional commits
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
      contents: write
      pull-requests: write
    steps:
      - uses: danielroe/uppt/pr@91974ad6e7fd9fd91ce562b0d371eeaceedb1f49 # v0.6.4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          prerelease: ${{ inputs.prerelease }}

  # release PR merged: tag it, cut a GitHub release, dispatch the publish run
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
      contents: write
      actions: write
    steps:
      - uses: danielroe/uppt/release@91974ad6e7fd9fd91ce562b0d371eeaceedb1f49 # v0.6.4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  # the chained dispatch lands here on the vX.Y.Z tag; build the tarball(s)
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
        uses: danielroe/uppt/pack@91974ad6e7fd9fd91ce562b0d371eeaceedb1f49 # v0.6.4

  # stage the prebuilt tarball(s) to npm via OIDC
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
      id-token: write
    environment: npm
    steps:
      - uses: danielroe/uppt/publish@91974ad6e7fd9fd91ce562b0d371eeaceedb1f49 # v0.6.4
        with:
          files: ${{ needs.pack.outputs.files }}
```

## How it works

1. **`uppt/pr`** - on every push to the default branch, parses conventional commits since the latest tag, decides the bump (major/minor/patch), pushes a `release/vX.Y.Z` branch with the version bump, and opens or updates a draft release PR (closing any superseded ones).
2. **`uppt/release`** - when the release PR is merged, tags the squash commit, creates a GitHub Release from the PR body, and dispatches the publish workflow on the new tag.
3. **`uppt/pack`** - installs dependencies, runs `pnpm pack` (if `pnpm-lock.yaml` exists) or `npm pack`, and uploads the tarball(s) as a workflow artifact, exposing a `files` output.
4. **`uppt/publish`** - downloads the artifact and runs `npm stage publish` with OIDC. You then approve the staged version on npmjs.com.

> [!TIP]
> You can edit the release PR to add your own release notes. Anything above `## 👉 Changelog` is preserved when the changelog is updated.

### Inputs

All subactions take a `node-version` input (default `24`; uppt needs `--experimental-strip-types`, so Node 22.6+ also works) and, where applicable, a `checkout` input (`true` by default; set to `false` if the caller has already checked out the right ref - `fetch-depth: 0` for `pr`, the merge commit for `release`, the tag for `pack`).

<details>
<summary><code>uppt/pr</code></summary>

| Input | Default | Description |
| --- | --- | --- |
| `token` | `${{ github.token }}` | Needs `contents: write` and `pull-requests: write`. |
| `base-branch` | default branch | Base branch for the release PR. |
| `packages` | _(unset)_ | Newline-separated list of publishable workspace directories (paths or globs, e.g. `packages/*`). See [Monorepo support](#monorepo-support). |
| `allow-forks` | `false` | By default the action skips on forks so they don't open release PRs of their own. |
| `prerelease` | _(unset)_ | One-shot prerelease identifier (`beta`, `rc`, or a bare number). See [Prereleases](#prereleases). |
</details>

<details>
<summary><code>uppt/release</code></summary>

| Input | Default | Description |
| --- | --- | --- |
| `token` | `${{ github.token }}` | Needs `contents: write` and `actions: write`. |
| `publish-workflow` | `release.yml` | Workflow filename to dispatch after tagging. Must declare `workflow_dispatch`. |
| `mode` | `lockstep` | `lockstep` or `independent`. Must match `uppt/pr`. See [Independent versioning](#independent-versioning-experimental). |
| `allow-forks` | `false` | By default the action skips on forks so they don't tag or publish releases of their own. |
</details>

<details>
<summary><code>uppt/pack</code></summary>

| Input | Default | Description |
| --- | --- | --- |
| `install` | `true` | Set to `false` to handle `actions/setup-node` and dependency installation yourself (pinned package manager, cached `node_modules`, hardened install policy). The caller must then put `node`, `npm`, and any package manager on PATH first. |
| `packages` | _(unset)_ | Must match the value passed to `uppt/pr`. |
| `releases` | _(unset)_ | Independent-mode publish payload, from the workflow's `releases` dispatch input. Never set by hand. |

| Output | Description |
| --- | --- |
| `files` | JSON array of tarball filenames (e.g. `["my-pkg-1.2.3.tgz"]`). Pass to `uppt/publish` via its `files` input. |
</details>

<details>
<summary><code>uppt/publish</code></summary>

| Input | Default | Description |
| --- | --- | --- |
| `npm-access` | `public` | npm access level (`public` or `restricted`). |
| `files` | _(scan artifact)_ | JSON array of tarball filenames, as emitted by `uppt/pack`. When omitted, every `*.tgz` in the artifact is published. |
| `releases` | _(unset)_ | Independent-mode publish payload. Never set by hand. |
</details>

## Lifecycle scripts

uppt runs your package's lifecycle scripts at one specific point and skips them everywhere else, so the runner that produces the tarball executes as little third-party code as possible:

- **Install** (in `uppt/pack`): runs with `--ignore-scripts`. Dependencies' `postinstall` hooks and your own `prepare` do **not** fire; this is why a compromised transitive dependency can't run code on the publish runner. If your build genuinely needs a dependency's `postinstall`, set `install: false` and install yourself.
- **Pack** (in `uppt/pack`): `prepack`, `prepare`, and `postpack` run. This is where your build belongs.
- **Publish** (in `uppt/publish`): nothing runs, including `prepublishOnly`. Move any `prepublishOnly` logic into `prepack`.

## Prereleases

To cut a prerelease, run the release workflow from your default branch with the `prerelease` input set:

```bash
gh workflow run release.yml -f prerelease=beta
```

From `4.5.2`, if there's been a breaking change this will open a PR for `5.0.0-beta.0`. Running it again will produce `5.0.0-beta.1`. A different identifier will reset the counter (`5.0.0-rc.0`), or a bare number produces the `5.0.0-0` style. It's one-shot: the next ordinary push opens a PR for a stable release (e.g. `5.0.0`) instead.

## Monorepo support

For a lockstep monorepo (where every publishable package shares a single version and one `vX.Y.Z` tag), pass the same `packages:` input to `uppt/pr`, `uppt/release`, and `uppt/pack`:

```yaml
        with:
          # ...
          packages: |
            packages/*
            !packages/playground
```

Each line is a directory path or glob; `!`-prefixed entries are excluded; workspaces with `"private": true` are silently skipped.

Every listed package must agree on a single semver `version`. The root `package.json#version` is only bumped when it already matches, so a `0.0.0` or absent root version is left untouched.

> [!IMPORTANT]
> The `packages:` value must match across all three subactions, or the release PR, the tag, and the published tarballs will cover different sets of packages. And if you use pnpm, every listed workspace must also be in `pnpm-workspace.yaml`, or `workspace:`/`catalog:` specifiers won't resolve at pack time.

### Independent versioning (experimental)

If lockstep is the wrong shape (one package on `0.8.0`, another on `0.2.1`), set `mode: independent` alongside `packages:` on `uppt/pr` and `uppt/release`, and each package will advance on its own cadence.

Commits are routed to packages by conventional-commit scope. By default a package claims the last segment of its name (`feat(kit):` bumps `@nuxt/kit`); override or alias this with `scopes:` on `uppt/pr`:

```yaml
          scopes: |
            @nuxt/kit: kit nuxt-kit
            @nuxt/schema: schema
```

A comma-separated scope (`fix(fontaine,fontless):`) bumps every package it names. Commits with no scope, or an unmatched scope, do not bump anything.

> [!NOTE]
> Bumping a package also releases anything that depends on it via `dependencies`, `peerDependencies`, or `optionalDependencies`.

You get a single `release/<base>-pending` PR with a section per package. On merge, uppt tags each released package as `<name>@X.Y.Z`, creates one GitHub release on a `release-YYYY-MM-DD` coordination tag, and dispatches the publish workflow with a `releases` payload naming the packages to pack and stage. They go live together when you approve them on npmjs.com.

The workflow needs a few changes on top of the lockstep setup: a `releases` dispatch input, `mode: independent`, a looser `release/` head-ref guard, and job conditions that accept the coordination tag.

<details>
<summary>Full independent-mode workflow</summary>

```yaml
name: release

on:
  push:
    branches: [main]
  pull_request:
    types: [closed]
    branches: [main]
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
      contents: write
      pull-requests: write
    steps:
      - uses: danielroe/uppt/pr@91974ad6e7fd9fd91ce562b0d371eeaceedb1f49 # v0.6.4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          prerelease: ${{ inputs.prerelease }}
          mode: independent
          packages: |
            packages/*

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
      contents: write
      actions: write
    steps:
      - uses: danielroe/uppt/release@91974ad6e7fd9fd91ce562b0d371eeaceedb1f49 # v0.6.4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          mode: independent
          packages: |
            packages/*

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
        uses: danielroe/uppt/pack@91974ad6e7fd9fd91ce562b0d371eeaceedb1f49 # v0.6.4
        with:
          releases: ${{ inputs.releases }}
          packages: |
            packages/*

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
      id-token: write
    environment: npm
    steps:
      - uses: danielroe/uppt/publish@91974ad6e7fd9fd91ce562b0d371eeaceedb1f49 # v0.6.4
        with:
          files: ${{ needs.pack.outputs.files }}
          releases: ${{ inputs.releases }}
```
</details>

When `releases` is empty every action behaves exactly as in lockstep mode, so rerunning a publish by hand on a `v*` tag still works.

> [!NOTE]
> Independent mode is new and hasn't been through many real releases yet. If something looks wrong, please open an issue.

> [!IMPORTANT]
> When switching an existing repo over: if your `npm` environment only allows `v*` tags to deploy, add `release-*` (independent-mode publishes run on the coordination tag). Existing tags are fine as they are: uppt reads `<name>@X.Y.Z` tags, and a package with no tag of its own falls back to the newest `vX.Y.Z`, so the first independent run only releases what has actually changed.

## Credits

Inspired by [unjs/changelogen](https://github.com/unjs/changelogen) and [antfu/changelogithub](https://github.com/antfu/changelogithub/). You might also want to check out [changesets](https://github.com/changesets/changesets) and [release-please](https://github.com/googleapis/release-please).

## License

Made with ❤️

Published under [MIT License](./LICENCE).
