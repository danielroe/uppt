// Base branch and prerelease identifier for a `uppt/pr` run: the action
// inputs, or for a push to `release/v*`, those of that branch's open PR.
//
// Env:
//   GITHUB_REF         ref that triggered the run
//   GITHUB_REPOSITORY  "owner/repo"
//   GITHUB_TOKEN       token for the PR lookup
//   BASE_BRANCH        `base-branch` input
//   PRERELEASE         `prerelease` input
//   GITHUB_OUTPUT      receives `skip`, `base` and `prerelease`

import process from 'node:process'
import { appendFileSync } from 'node:fs'
import { runMain } from './_cli.ts'

/** Identifier that continues the prerelease line of `version`, or `''` for a stable version. */
export function prereleaseIdentifier (version: string): string {
  const pre = version.match(/^\d+\.\d+\.\d+-([0-9a-zA-Z.-]+)$/)?.[1]
  if (!pre) return ''
  if (/^\d+$/.test(pre)) return '0'
  return pre.replace(/\.\d+$/, '')
}

export async function main () {
  const ref = process.env.GITHUB_REF ?? ''
  const output = (values: Record<string, string>) => {
    const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('')
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
    else process.stdout.write(lines)
  }

  const branch = ref.match(/^refs\/heads\/(release\/v.+)$/)?.[1]
  if (!branch) {
    output({ skip: 'false', base: process.env.BASE_BRANCH ?? '', prerelease: process.env.PRERELEASE ?? '' })
    return
  }

  const repo = process.env.GITHUB_REPOSITORY!
  const owner = repo.split('/')[0]
  const token = process.env.GITHUB_TOKEN
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'release-pr-updater',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`GitHub GET pulls for ${branch} -> ${res.status} ${res.statusText}: ${await res.text()}`)
  const [pr] = await res.json() as Array<{ base: { ref: string } }>
  if (!pr) {
    console.log(`::notice::danielroe/uppt/pr skipped: ${branch} has no open release PR.`)
    output({ skip: 'true', base: '', prerelease: '' })
    return
  }
  output({ skip: 'false', base: pr.base.ref, prerelease: prereleaseIdentifier(branch.slice('release/v'.length)) })
}

runMain(import.meta.url, main)
