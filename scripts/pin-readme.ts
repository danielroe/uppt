// Pin the `uses: danielroe/uppt/<sub>@<ref>` lines in `README.md` to the
// SHA of the tag that just triggered this run, and commit directly to
// `main` via the GitHub Contents API.
//
// Env:
//   GITHUB_TOKEN       required (contents: write on the repo)
//   GITHUB_REPOSITORY  "owner/repo" (set automatically inside Actions)
//   GITHUB_REF_NAME    tag name, e.g. "v1.2.3" (set automatically)
//   GITHUB_SHA         commit SHA the tag points at (set automatically)

import process from 'node:process'
import { Buffer } from 'node:buffer'

interface GhRefResponse { object: { sha: string } }
interface GhContentResponse { sha: string, content: string, encoding: 'base64' }
interface GhPutResponse { commit: { sha: string, html_url: string } }

async function gh<T> (token: string, method: string, path: string, body?: unknown): Promise<{ status: number, data: T }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'danielroe/uppt pin-readme',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) as T : ({} as T)
  if (!res.ok && res.status !== 409 && res.status !== 422) {
    throw new Error(`${method} ${path} failed: ${res.status} ${text}`)
  }
  return { status: res.status, data }
}

function rewrite (readme: string, sha: string, tag: string) {
  // Match `uses: danielroe/uppt/<sub>@<ref>` optionally followed by a `#
  // <version>` trailing comment. `<sub>` is restricted to the three known
  // subactions so we don't accidentally rewrite future siblings.
  const pinRe = /(\buses:\s*danielroe\/uppt\/(?:pr|release|pack|publish))@\S+(?:\s+#\s*v\S+)?/g
  return readme.replace(pinRe, (_match, prefix: string) => `${prefix}@${sha} # ${tag}`)
}

async function main () {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required')

  const repo = process.env.GITHUB_REPOSITORY
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`GITHUB_REPOSITORY invalid: ${repo}`)

  const tag = process.env.GITHUB_REF_NAME ?? ''
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`GITHUB_REF_NAME is not a semver tag: ${tag}`)
  }

  const sha = process.env.GITHUB_SHA ?? ''
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GITHUB_SHA invalid: ${sha}`)

  // Discover the default branch rather than hardcoding `main`. The release
  // workflow already parameterises this via `base-branch`; mirror that here
  // so a fork on a non-`main` default doesn't break.
  const { data: repoData } = await gh<{ default_branch: string }>(token, 'GET', `/repos/${repo}`)
  const branch = repoData.default_branch
  if (!branch) throw new Error('Could not resolve default branch')

  // Retry loop: if `main` advances between read and write, GitHub returns
  // 409 (or 422 with "does not match") and we restart from the new head.
  // In practice this almost never fires; the window is seconds wide and
  // releases are not concurrent. Cap at a small number so a genuine
  // conflict (someone hand-editing the README between read and write)
  // surfaces as a workflow failure rather than spinning.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { data: file } = await gh<GhContentResponse>(
      token,
      'GET',
      `/repos/${repo}/contents/README.md?ref=${encodeURIComponent(branch)}`,
    )
    if (file.encoding !== 'base64') throw new Error(`Unexpected README encoding: ${file.encoding}`)
    const before = Buffer.from(file.content, 'base64').toString('utf8')
    const after = rewrite(before, sha, tag)

    if (after === before) {
      console.log('README.md already pinned to the current release; nothing to do.')
      return
    }

    const put = await gh<GhPutResponse>(token, 'PUT', `/repos/${repo}/contents/README.md`, {
      message: `chore: pin README example to ${tag}`,
      content: Buffer.from(after, 'utf8').toString('base64'),
      sha: file.sha,
      branch,
    })

    if (put.status === 409 || put.status === 422) {
      console.log(`attempt ${attempt}: ${branch} advanced under us, retrying`)
      continue
    }
    if (put.status < 200 || put.status >= 300) {
      throw new Error(`PUT contents returned ${put.status}`)
    }

    console.log(`pinned README.md to ${tag} in ${put.data.commit.html_url}`)
    return
  }

  throw new Error('Exhausted retries trying to update README.md')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
