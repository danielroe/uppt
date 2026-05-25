# Security Policy

## Reporting a vulnerability

Please report security issues privately, **not** via a public issue or pull request.

**Preferred**: [open a private vulnerability report](https://github.com/danielroe/uppt/security/advisories/new) on this repository.

If that doesn't work for you, email **daniel@roe.dev** with the details.

A useful report includes: the affected version (commit SHA or tag), the conditions that trigger the issue, and a reproduction or proof-of-concept if you have one. If you're not sure whether something is a vulnerability, send it anyway. False alarms are much cheaper than missed reports.

## Scope

uppt is a release tool. Its three subactions run with elevated permissions in the caller's workflow: `contents: write` and `pull-requests: write` for `uppt/pr`, `contents: write` and `actions: write` for `uppt/release`, and an npm OIDC token (`id-token: write`) for `uppt/publish`. The npm OIDC token is the highest-value secret in scope.

In scope:

- Anything that lets a non-maintainer (including a fork-PR author) cause uppt to tag, release, publish, or commit on their behalf.
- Anything that lets uppt publish an attacker-chosen version, an attacker-chosen tarball, or attacker-chosen content under a tag.
- Exfiltration of `GITHUB_TOKEN`, npm OIDC tokens, or any other secret reaching a uppt step.
- Bypasses of the input validation in `scripts/` (semver pinning, ref-shape checks, event-name guards).
- Issues in the workflows uppt ships with itself (`.github/workflows/`).

Out of scope:

- Bugs in upstream tooling: `actions/checkout`, `actions/setup-node`, `npm`, `pnpm`, `yarn`, `corepack`, the Node runtime. Please report those upstream.
- Bugs in the caller's workflow YAML (missing `permissions:` blocks, overly broad triggers, leaked tokens) that are not caused by following uppt's documented setup.
- Maintainer key compromise on the consuming side (lost npm credentials, leaked PATs).
- Findings that require the attacker to already have write access to the repository.

## Known limitations

These are deliberate trade-offs, documented here so they're not surprises:

- **`uppt/publish` runs the caller's lifecycle scripts in the same job that holds the npm OIDC token.** `pnpm install` and `npm ci` run with `--ignore-scripts`, but `pnpm pack` (used when a `pnpm-lock.yaml` is present) executes the package's own `prepack`/`prepare`/`prepublishOnly` scripts. A compromised script in the caller's own package will run with the npm OIDC token in scope. uppt does not sandbox lifecycle scripts.

## Coordinated disclosure

I'll credit reporters in the published advisory unless you ask me not to. If you're working to a disclosure timeline, mention it in the initial report and I'll align with it. I won't pursue legal action against good-faith reports made under this policy.
