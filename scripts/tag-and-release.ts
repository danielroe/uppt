// Tag the squash-merge commit, create a GitHub release from the PR body,
// and dispatch the publish workflow.
//
// Runs on `pull_request: closed` after the caller's workflow has checked
// out the merge commit (`ref: github.event.pull_request.merge_commit_sha`).
// The version is read from `package.json` at that ref, not from the branch name.
//
// Env:
//   GITHUB_TOKEN           required (tag push, release create, workflow dispatch)
//   GITHUB_REPOSITORY      "owner/repo" (set automatically inside Actions)
//   PR_BODY                PR body, used verbatim as release notes
//   PUBLISH_WORKFLOW       workflow filename to dispatch (default: release.yml)
//   BASE_BRANCH            branch the release PR was merged into
//   DEFAULT_BRANCH         the repo's default branch. When BASE_BRANCH differs
//                          this is a maintenance release: it publishes to
//                          `<major>x` and does not become the latest release.
//   NPM_TAG                dist-tag override, for lines whose tag isn't
//                          `<major>x` (`legacy`, `v3-latest`)
//   PACKAGES               newline-separated list of publishable workspace
//                          dirs/globs (monorepo); omit for single-package repos
//   MODE                   "lockstep" (default) or "independent". Independent
//                          mode derives the release set from the tree (each
//                          workspace's version vs its latest `<name>@X.Y.Z`
//                          tag), fans out one tag per released package, cuts a
//                          single release on a `release-YYYY-MM-DD`
//                          coordination tag, and dispatches the publish
//                          workflow with a `releases` payload input.

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { runMain } from './_cli.ts'
import { isPrerelease, isSemver, resolveCurrentVersion, resolveWorkspaces } from './_workspaces.ts'
import { coordinationTag, deriveReleaseSet, packageTag, releaseTitle, serialiseReleases } from './_independent.ts'
import { getAllTags } from './update-changelog.ts'

const DIST_TAG_RE = /^[a-z0-9][\w.-]*$/i

/**
 * dist-tag the publish job should use, and hence whether this release is the
 * repo's latest. A release merged into a branch other than the default one is
 * by definition not the newest line, so it publishes to `<major>x` (`3x`)
 * rather than moving `latest` backwards. `NPM_TAG` overrides the derivation.
 * Returns `undefined` when the publish job's own derivation is right.
 *
 * @param versions versions being released; they must share a major for a
 * derived tag to be meaningful.
 */
function resolveDistTag (versions: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.NPM_TAG?.trim()
  if (override) {
    if (!DIST_TAG_RE.test(override) || isSemver(override)) {
      throw new Error(`\`npm-tag\` is not a valid dist-tag: ${JSON.stringify(override)}`)
    }
    return override
  }

  const base = env.BASE_BRANCH?.trim()
  const defaultBranch = env.DEFAULT_BRANCH?.trim()
  if (!base || !defaultBranch || base === defaultBranch) return undefined
  // A prerelease already publishes to its own identifier and is never the
  // latest release, so there's nothing for the branch to add.
  if (versions.every(isPrerelease)) return undefined

  const majors = new Set(versions.map(version => version.split('.')[0]!))
  if (majors.size > 1) {
    throw new Error(
      `Releasing from "${base}" (not the default branch "${defaultBranch}") means this is not the newest release line, `
      + `but the release spans majors ${[...majors].sort().join(', ')}, so there is no single dist-tag to derive. `
      + 'Set the `npm-tag` input explicitly.',
    )
  }
  return `${[...majors][0]}x`
}

/**
 * Flags controlling whether GitHub treats the release as the repo's latest.
 * A prerelease is never latest, and neither is anything publishing to a
 * dist-tag other than `latest`.
 */
function latestFlags (opts: { prerelease: boolean, distTag: string | undefined }): string[] {
  if (opts.distTag) return opts.distTag === 'latest' ? ['--latest'] : ['--latest=false']
  return opts.prerelease ? ['--prerelease'] : []
}

/** `gh workflow run` inputs carrying the derived dist-tag, if there is one. */
function distTagInput (distTag: string | undefined): string[] {
  return distTag ? ['-f', `npm-tag=${distTag}`] : []
}

function run (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...opts.env } })
}

const MAX_BUFFER = 256 * 1024 * 1024

function capture (cmd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, env: { ...process.env, ...env } }).trim()
}

function tagExists (repo: string, tag: string, env: NodeJS.ProcessEnv): boolean {
  // `gh api` exits non-zero on 404; treat that as "does not exist". Any other
  // failure (auth, network) we want to propagate, so we re-check by asking gh
  // to ignore HTTP errors and inspect the JSON.
  try {
    const out = execFileSync(
      'gh',
      ['api', '-H', 'Accept: application/vnd.github+json', `/repos/${repo}/git/ref/tags/${tag}`],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
    )
    return Boolean(out.trim())
  } catch {
    return false
  }
}

function createTag (repo: string, tag: string, sha: string, env: NodeJS.ProcessEnv) {
  // Create the tag via the GitHub API instead of `git push`, so this step
  // doesn't need git-level write credentials baked into the runner.
  run('gh', [
    'api', '-X', 'POST',
    '-H', 'Accept: application/vnd.github+json',
    `/repos/${repo}/git/refs`,
    '-f', `ref=refs/tags/${tag}`,
    '-f', `sha=${sha}`,
  ], { env })
}

function mainIndependent (repo: string, ghEnv: NodeJS.ProcessEnv) {
  const packagesInput = process.env.PACKAGES?.trim() ?? ''
  if (!packagesInput) throw new Error('`mode: independent` requires the `packages` input.')

  const workspaces = resolveWorkspaces(process.cwd(), packagesInput)
  const releases = deriveReleaseSet(workspaces, getAllTags())
  if (!releases.length) {
    throw new Error('No workspace version differs from its latest tag; nothing to release. Was the release PR merged without version bumps?')
  }

  const distTag = resolveDistTag(releases.map(release => release.version))

  const sha = capture('git', ['rev-parse', 'HEAD'])
  const localTags = new Set(getAllTags())
  const coordTag = coordinationTag(new Date(), tag => localTags.has(tag) || tagExists(repo, tag, ghEnv))
  const tags = [...releases.map(packageTag), coordTag]

  const existing = tags.filter(tag => tag !== coordTag && tagExists(repo, tag, ghEnv))
  if (existing.length) {
    throw new Error(`Refusing to tag: ${existing.join(', ')} already exist${existing.length === 1 ? 's' : ''} on ${repo}. If this is a rerun, delete the tags (and any release) from the previous attempt first.`)
  }

  const created: string[] = []
  for (const tag of tags) {
    try {
      createTag(repo, tag, sha, ghEnv)
      created.push(tag)
    }
    catch (err) {
      throw new Error(
        `Failed to create tag ${tag} (created so far: ${created.join(', ') || '<none>'}). `
        + 'No release was created and no publish was dispatched. Delete the created tags and rerun, or create the remaining tags manually.',
        { cause: err },
      )
    }
  }

  const body = process.env.PR_BODY ?? ''
  // A mixed set (some prerelease, some stable) still deserves to be latest,
  // so the prerelease check requires every released package to qualify.
  const flags = latestFlags({
    prerelease: releases.every(release => isPrerelease(release.version)),
    distTag,
  })
  run('gh', ['release', 'create', coordTag, '--title', releaseTitle(releases), '--notes', body, ...flags], { env: ghEnv })

  const workflow = process.env.PUBLISH_WORKFLOW || 'release.yml'
  run('gh', ['workflow', 'run', workflow, '--ref', coordTag, '-f', `releases=${serialiseReleases(releases)}`, ...distTagInput(distTag)], { env: ghEnv })

  console.log(`Tagged ${releases.length} package${releases.length === 1 ? '' : 's'} (${releases.map(packageTag).join(', ')}) plus ${coordTag}, created release, dispatched ${workflow}.`)
}

export function main () {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required')
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo || !repo.includes('/')) throw new Error('GITHUB_REPOSITORY is required')

  const mode = process.env.MODE?.trim() || 'lockstep'
  if (mode !== 'lockstep' && mode !== 'independent') {
    throw new Error(`Invalid \`mode\` input "${mode}": expected "lockstep" or "independent".`)
  }
  if (mode === 'independent') {
    mainIndependent(repo, { GH_TOKEN: token })
    return
  }

  const version = resolveCurrentVersion(process.cwd(), process.env.PACKAGES?.trim() ?? '')
  // `version` flows into ref names and `gh` argv. Pin to strict semver to
  // rule out flag-injection (`--upload-pack=...`) and ref-confusion attacks.
  if (!isSemver(version)) {
    throw new Error(`Refusing to tag: resolved version "${version}" is not strict semver`)
  }
  const tag = `v${version}`
  const ghEnv = { GH_TOKEN: token }

  if (tagExists(repo, tag, ghEnv)) {
    throw new Error(`Refusing to tag: ${tag} already exists on ${repo}. If this is a rerun, delete the tag and the release first, or bump the version.`)
  }

  const distTag = resolveDistTag([version])
  const flags = latestFlags({ prerelease: isPrerelease(version), distTag })

  const sha = capture('git', ['rev-parse', 'HEAD'])
  createTag(repo, tag, sha, ghEnv)

  const body = process.env.PR_BODY ?? ''
  run('gh', ['release', 'create', tag, '--title', tag, '--notes', body, ...flags], { env: ghEnv })

  const workflow = process.env.PUBLISH_WORKFLOW || 'release.yml'
  run('gh', ['workflow', 'run', workflow, '--ref', tag, ...distTagInput(distTag)], { env: ghEnv })

  console.log(`Tagged ${tag}, created release, dispatched ${workflow}.`)
}

runMain(import.meta.url, main)
