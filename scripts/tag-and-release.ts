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

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function run (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...opts.env } })
}

function main () {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required')

  const pkgPath = resolve(process.cwd(), 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  // `pkg.version` flows into `git tag` and `gh` argv. Pin to strict semver to
  // rule out flag-injection (`--upload-pack=...`) and ref-confusion attacks.
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(pkg.version)) {
    throw new Error(`Refusing to tag: package.json version "${pkg.version}" is not strict semver`)
  }
  const tag = `v${pkg.version}`

  run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'])
  run('git', ['config', 'user.name', 'github-actions[bot]'])
  run('git', ['tag', tag])
  run('git', ['push', 'origin', tag])

  const body = process.env.PR_BODY ?? ''
  run('gh', ['release', 'create', tag, '--title', tag, '--notes', body], {
    env: { GH_TOKEN: token },
  })

  const workflow = process.env.PUBLISH_WORKFLOW || 'release.yml'
  run('gh', ['workflow', 'run', workflow, '--ref', tag], {
    env: { GH_TOKEN: token },
  })

  console.log(`Tagged ${tag}, created release, dispatched ${workflow}.`)
}

try {
  main()
}
catch (err) {
  console.error(err)
  process.exit(1)
}
