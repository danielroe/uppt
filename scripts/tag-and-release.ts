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
//   PACKAGES               newline-separated list of publishable workspace
//                          dirs/globs (monorepo); omit for single-package repos

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { isSemver, resolveCurrentVersion } from './_workspaces.ts'

function run (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...opts.env } })
}

function capture (cmd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim()
}

function tagExists (repo: string, tag: string, env: NodeJS.ProcessEnv): boolean {
  // `gh api` exits non-zero on 404; treat that as "does not exist". Any other
  // failure (auth, network) we want to propagate, so we re-check by asking gh
  // to ignore HTTP errors and inspect the JSON.
  try {
    const out = execFileSync(
      'gh',
      ['api', '-H', 'Accept: application/vnd.github+json', `/repos/${repo}/git/ref/tags/${tag}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
    )
    return Boolean(out.trim())
  } catch {
    return false
  }
}

function main () {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required')
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo || !repo.includes('/')) throw new Error('GITHUB_REPOSITORY is required')

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

  // Create the tag via the GitHub API instead of `git push`, so this step
  // doesn't need git-level write credentials baked into the runner.
  const sha = capture('git', ['rev-parse', 'HEAD'])
  run('gh', [
    'api', '-X', 'POST',
    '-H', 'Accept: application/vnd.github+json',
    `/repos/${repo}/git/refs`,
    '-f', `ref=refs/tags/${tag}`,
    '-f', `sha=${sha}`,
  ], { env: ghEnv })

  const body = process.env.PR_BODY ?? ''
  run('gh', ['release', 'create', tag, '--title', tag, '--notes', body], { env: ghEnv })

  const workflow = process.env.PUBLISH_WORKFLOW || 'release.yml'
  run('gh', ['workflow', 'run', workflow, '--ref', tag], { env: ghEnv })

  console.log(`Tagged ${tag}, created release, dispatched ${workflow}.`)
}

try {
  main()
}
catch (err) {
  console.error(err)
  process.exit(1)
}
