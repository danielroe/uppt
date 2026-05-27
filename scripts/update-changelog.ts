// Zero-dependency release-PR updater.
//
// Reads the conventional commits since the latest tag, decides the next
// semver bump, and creates or updates a draft "release PR" against the
// default branch. The PR body is a generated changelog plus a contributor
// list pulled from the GitHub API.
//
// Env:
//   GITHUB_TOKEN       required for PR create/update; optional for read-only
//                      contributor + PR lookups (public endpoints work
//                      unauthenticated against public repos, just with a
//                      60 req/hr ceiling).
//   GITHUB_REPOSITORY  "owner/repo" (set automatically inside Actions)
//   DRY_RUN            if set, skip git push and GitHub writes
//   RELEASE_BASE       override base branch (default: current branch)

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Commit {
  shortHash: string
  message: string
  type: string
  scope: string
  description: string
  isBreaking: boolean
  author: { name: string, email: string }
  references: string[]
}

interface Contributor {
  name: string
  username: string
  isFirstTime: boolean
}

const TYPE_TITLES: Record<string, string> = {
  feat: '🚀 Enhancements',
  perf: '🔥 Performance',
  fix: '🩹 Fixes',
  refactor: '💅 Refactors',
  docs: '📖 Documentation',
  build: '📦 Build',
  types: '🌊 Types',
  chore: '🏡 Chore',
  examples: '🏀 Examples',
  test: '✅ Tests',
  style: '🎨 Styles',
  ci: '🤖 CI',
}

const KNOWN_TYPES = new Set(Object.keys(TYPE_TITLES))

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).trim()

function getRepo (): { owner: string, repo: string } {
  const env = process.env.GITHUB_REPOSITORY
  if (env && env.includes('/')) {
    const [owner, repo] = env.split('/')
    return { owner: owner!, repo: repo! }
  }
  const url = git('remote', 'get-url', 'origin')
  const match = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) throw new Error(`Cannot parse repo from remote url: ${url}`)
  return { owner: match[1]!, repo: match[2]! }
}

function getCurrentBranch (): string {
  return process.env.RELEASE_BASE || git('rev-parse', '--abbrev-ref', 'HEAD')
}

interface Tag { name: string, ref: string }

function getLatestTag (): Tag | null {
  // Pick the most recent semver-shaped tag by creation date. We deliberately
  // don't use `git describe`, which only finds tags reachable from HEAD; the
  // previous release tag isn't always an ancestor of HEAD (e.g. release
  // branches that were never merged back).
  //
  // We return both the short name (for display / URLs) and the fully
  // qualified ref (`refs/tags/...`) so subsequent git calls aren't confused
  // by branches sharing the tag name.
  try {
    const stdout = execFileSync(
      'git',
      ['for-each-ref', '--sort=-creatordate', '--format=%(refname:strip=2)', 'refs/tags'],
      { encoding: 'utf8' },
    )
    const name = stdout.split('\n').map(s => s.trim()).find(t => /^v?\d+\.\d+\.\d+/.test(t))
    return name ? { name, ref: `refs/tags/${name}` } : null
  } catch {
    return null
  }
}

function parseCommit (raw: string): Commit | null {
  const [shortHash, authorName, authorEmail, subject, body] = raw.split('\x1f')
  if (!shortHash || !subject) return null

  const header = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/)
  if (!header) {
    return {
      shortHash,
      message: subject,
      type: '',
      scope: '',
      description: subject,
      isBreaking: false,
      author: { name: authorName || '', email: authorEmail || '' },
      references: [],
    }
  }
  const [, type, scope = '', bang, rawDescription] = header
  const isBreaking = Boolean(bang) || /BREAKING[ -]CHANGE/.test(body || '')

  const references: string[] = []
  for (const m of (body || '').matchAll(/(?:closes?|fixes?|resolves?)\s+#(\d+)/gi)) {
    references.push(`#${m[1]}`)
  }
  for (const m of subject.matchAll(/\(#(\d+)\)/g)) {
    references.push(`#${m[1]}`)
  }
  // Drop trailing `(#nnn)` PR refs from the description: we'll re-attach them
  // in the rendered changelog from the deduped `references` list.
  const description = rawDescription!.replace(/\s*\(#\d+\)\s*$/, '').trim()

  return {
    shortHash,
    message: subject,
    type: type!.toLowerCase(),
    scope,
    description,
    isBreaking,
    author: { name: authorName || '', email: authorEmail || '' },
    references: [...new Set(references)],
  }
}

function getCommitsSince (tag: Tag | null): Commit[] {
  const range = tag ? `${tag.ref}..HEAD` : 'HEAD'
  const stdout = execFileSync(
    'git',
    ['log', range, `--pretty=format:%h%x1f%an%x1f%ae%x1f%s%x1f%b%x1e`],
    { encoding: 'utf8' },
  )
  return stdout
    .split('\x1e')
    .map(s => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map(parseCommit)
    .filter((c): c is Commit => c !== null)
}

function determineBump (commits: Commit[]): 'major' | 'minor' | 'patch' {
  if (commits.some(c => c.isBreaking)) return 'major'
  if (commits.some(c => c.type === 'feat')) return 'minor'
  return 'patch'
}

function incVersion (version: string, bump: 'major' | 'minor' | 'patch'): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) throw new Error(`Cannot parse version: ${version}`)
  let [, major, minor, patch] = match.map(Number) as [number, number, number, number, number]
  if (bump === 'major') { major += 1; minor = 0; patch = 0 }
  else if (bump === 'minor') { minor += 1; patch = 0 }
  else { patch += 1 }
  return `${major}.${minor}.${patch}`
}

function formatChangelog (
  commits: Commit[],
  opts: { owner: string, repo: string, fromRef: Tag | null, toRef: string },
): string {
  const grouped = new Map<string, Commit[]>()
  for (const c of commits) {
    if (!KNOWN_TYPES.has(c.type)) continue
    if (c.type === 'chore' && c.scope === 'deps') continue
    const list = grouped.get(c.type) || []
    list.push(c)
    grouped.set(c.type, list)
  }

  const lines: string[] = []
  if (opts.fromRef) {
    const compareUrl = `https://github.com/${opts.owner}/${opts.repo}/compare/${opts.fromRef.name}...${opts.toRef}`
    lines.push(`[compare changes](${compareUrl})`, '')
  }

  const commitUrl = (sha: string) =>
    `https://github.com/${opts.owner}/${opts.repo}/commit/${sha}`

  for (const type of Object.keys(TYPE_TITLES)) {
    const items = grouped.get(type)
    if (!items?.length) continue
    lines.push(`### ${TYPE_TITLES[type]}`, '')
    for (const c of items) {
      const scope = c.scope ? `**${c.scope}:** ` : ''
      const breaking = c.isBreaking ? '⚠️  ' : ''
      // Prefer PR references; fall back to a link to the commit itself so
      // every line is traceable to something on GitHub.
      const trailer = c.references.length
        ? ` (${c.references.join(', ')})`
        : ` ([\`${c.shortHash}\`](${commitUrl(c.shortHash)}))`
      lines.push(`- ${breaking}${scope}${c.description}${trailer}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

async function gh<T> (path: string, init: RequestInit & { requireAuth?: boolean } = {}): Promise<T> {
  const { requireAuth, ...rest } = init
  const token = process.env.GITHUB_TOKEN
  if (requireAuth && !token) throw new Error('GITHUB_TOKEN is required for this call')
  const res = await fetch(`https://api.github.com${path}`, {
    ...rest,
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'User-Agent': 'release-pr-updater',
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    throw new Error(`GitHub ${init.method || 'GET'} ${path} -> ${res.status} ${res.statusText}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

async function getContributors (
  commits: Commit[],
  repo: { owner: string, repo: string },
  cutoff: string | null,
): Promise<Contributor[]> {
  const out: Contributor[] = []
  const seenEmails = new Set<string>()
  const seenUsers = new Set<string>()

  for (const commit of commits) {
    if (commit.author.name === 'renovate[bot]') continue
    if (seenEmails.has(commit.author.email)) continue
    seenEmails.add(commit.author.email)

    let login: string | undefined
    try {
      const data = await gh<{ author: { login: string } | null }>(
        `/repos/${repo.owner}/${repo.repo}/commits/${commit.shortHash}`,
      )
      login = data.author?.login
    } catch {
      continue
    }
    if (!login || seenUsers.has(login)) continue
    seenUsers.add(login)

    // First-time contributor = no commits authored by them before the cutoff
    // (the previous release tag's commit date). If we have no previous tag
    // every contributor is, by definition, first-time.
    let isFirstTime = true
    if (cutoff) {
      try {
        const prior = await gh<unknown[]>(
          `/repos/${repo.owner}/${repo.repo}/commits?author=${encodeURIComponent(login)}&until=${encodeURIComponent(cutoff)}&per_page=1`,
        )
        isFirstTime = prior.length === 0
      } catch {
        isFirstTime = false
      }
    }

    out.push({ name: commit.author.name, username: login, isFirstTime })
  }
  return out
}

type ReleaseBranchState = 'missing' | 'at-base' | 'has-bump'

async function getReleaseBranchState (
  repo: { owner: string, repo: string },
  opts: { base: string, branch: string },
): Promise<ReleaseBranchState> {
  let branchHead: string
  try {
    const data = await gh<{ commit: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(opts.branch)}`,
    )
    branchHead = data.commit.sha
  } catch (err) {
    if (err instanceof Error && /-> 404\b/.test(err.message)) return 'missing'
    throw err
  }

  const baseInfo = await gh<{ commit: { sha: string } }>(
    `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(opts.base)}`,
  )
  return branchHead === baseInfo.commit.sha ? 'at-base' : 'has-bump'
}

interface FileToCommit {
  /** Path relative to the repo root, using forward slashes. */
  path: string
  /** Raw UTF-8 contents to write at that path. */
  content: string
}

/**
 * Land one atomic commit on `opts.branch` containing every file in
 * `opts.files`, using the Git Data API. Creates the branch at `opts.base`
 * if it doesn't exist yet. The resulting commit has the branch's current
 * tip as its sole parent (or `opts.base`'s tip, if the branch was just
 * created), so the ref fast-forwards.
 */
async function commitFilesToBranch (
  repo: { owner: string, repo: string },
  opts: { base: string, branch: string, message: string, files: FileToCommit[] },
): Promise<void> {
  if (!opts.files.length) {
    throw new Error('commitFilesToBranch: refusing to commit with no files')
  }

  let parentSha: string
  try {
    const branchInfo = await gh<{ commit: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(opts.branch)}`,
      { requireAuth: true },
    )
    parentSha = branchInfo.commit.sha
  } catch (err) {
    if (!(err instanceof Error) || !/-> 404\b/.test(err.message)) throw err
    const baseInfo = await gh<{ commit: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(opts.base)}`,
      { requireAuth: true },
    )
    await gh(`/repos/${repo.owner}/${repo.repo}/git/refs`, {
      method: 'POST',
      requireAuth: true,
      body: JSON.stringify({
        ref: `refs/heads/${opts.branch}`,
        sha: baseInfo.commit.sha,
      }),
    })
    parentSha = baseInfo.commit.sha
  }

  const parentCommit = await gh<{ tree: { sha: string } }>(
    `/repos/${repo.owner}/${repo.repo}/git/commits/${parentSha}`,
    { requireAuth: true },
  )

  const blobs = await Promise.all(opts.files.map(async (file) => {
    const blob = await gh<{ sha: string }>(
      `/repos/${repo.owner}/${repo.repo}/git/blobs`,
      {
        method: 'POST',
        requireAuth: true,
        body: JSON.stringify({
          content: Buffer.from(file.content, 'utf8').toString('base64'),
          encoding: 'base64',
        }),
      },
    )
    return { path: file.path, sha: blob.sha }
  }))

  const tree = await gh<{ sha: string }>(
    `/repos/${repo.owner}/${repo.repo}/git/trees`,
    {
      method: 'POST',
      requireAuth: true,
      body: JSON.stringify({
        base_tree: parentCommit.tree.sha,
        tree: blobs.map(b => ({
          path: b.path,
          mode: '100644',
          type: 'blob',
          sha: b.sha,
        })),
      }),
    },
  )

  const commit = await gh<{ sha: string }>(
    `/repos/${repo.owner}/${repo.repo}/git/commits`,
    {
      method: 'POST',
      requireAuth: true,
      body: JSON.stringify({
        message: opts.message,
        tree: tree.sha,
        parents: [parentSha],
      }),
    },
  )

  await gh(`/repos/${repo.owner}/${repo.repo}/git/refs/heads/${opts.branch}`, {
    method: 'PATCH',
    requireAuth: true,
    body: JSON.stringify({ sha: commit.sha }),
  })
}

async function isReleaseMergeCommit (
  repo: { owner: string, repo: string },
  sha: string,
): Promise<boolean> {
  // We don't want to update the changelog when a `release/vX.Y.Z` PR is merged.
  try {
    const prs = await gh<Array<{ head: { ref: string }, merged_at: string | null }>>(
      `/repos/${repo.owner}/${repo.repo}/commits/${sha}/pulls`,
    )
    return prs.some(pr => pr.merged_at && pr.head.ref.startsWith('release/v'))
  } catch {
    return false
  }
}

async function main () {
  const dryRun = Boolean(process.env.DRY_RUN)
  const repo = getRepo()
  const baseBranch = getCurrentBranch()

  const headSha = git('rev-parse', 'HEAD')
  if (await isReleaseMergeCommit(repo, headSha)) {
    console.log(`HEAD (${headSha.slice(0, 7)}) is the merge of a release PR; skipping.`)
    return
  }

  const latestTag = getLatestTag()

  const commits = getCommitsSince(latestTag).filter(
    c => KNOWN_TYPES.has(c.type) && !(c.type === 'chore' && c.scope === 'deps'),
  )

  if (!commits.length) {
    console.log('No release-worthy commits since', latestTag?.name ?? 'repo root')
    return
  }

  const pkgPath = resolve(process.cwd(), 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const bump = determineBump(commits)
  const newVersion = incVersion(pkg.version, bump)
  const releaseBranch = `release/v${newVersion}`

  const changelog = formatChangelog(commits, {
    owner: repo.owner,
    repo: repo.repo,
    fromRef: latestTag,
    toRef: releaseBranch,
  })

  console.log(`Current: ${pkg.version}  ->  ${newVersion} (${bump})`)
  console.log(`Base branch: ${baseBranch}`)
  console.log(`Release branch: ${releaseBranch}`)
  console.log(`Commits: ${commits.length}`)

  // Close any open release PRs that don't match the new target version,
  // scoped to PRs targeting the *same* base branch. Repos with maintenance
  // branches (e.g. nuxt's `main`, `4.x`, `3.x`) have a release PR per base;
  // a `feat:` landing on `main` must not close the `4.x`-base PR. The common
  // single-branch case: a patch PR (`release/v1.0.1`) gets superseded by a
  // `feat:` that bumps the target to `release/v1.1.0`. We close the stale PR,
  // lift its preamble (so the maintainer's intro text isn't lost), and
  // delete its branch.
  let seedPreamble: string | null = null
  if (!dryRun && process.env.GITHUB_TOKEN) {
    const openReleasePRs = await gh<Array<{ number: number, body: string | null, head: { ref: string, repo: { full_name: string } | null }, base: { ref: string }, updated_at: string }>>(
      `/repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=100&base=${encodeURIComponent(baseBranch)}&head=${repo.owner}:`,
      { requireAuth: true },
    )
    const sameRepo = `${repo.owner}/${repo.repo}`
    const stale = openReleasePRs
      .filter(pr =>
        pr.head.repo?.full_name === sameRepo
        && pr.head.ref.startsWith('release/v')
        && pr.head.ref !== releaseBranch
        && pr.base.ref === baseBranch,
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    for (const pr of stale) {
      console.log(`Closing superseded release PR #${pr.number} (${pr.head.ref})`)
      const preamble = pr.body?.replace(/## 👉 Changelog[\s\S]*$/, '').trim()
      if (preamble && !seedPreamble) seedPreamble = preamble
      await gh(`/repos/${repo.owner}/${repo.repo}/pulls/${pr.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
        requireAuth: true,
      })
      try {
        await gh(`/repos/${repo.owner}/${repo.repo}/git/refs/heads/${pr.head.ref}`, {
          method: 'DELETE',
          requireAuth: true,
        })
      }
      catch (err) {
        console.warn(`  could not delete branch ${pr.head.ref}:`, err)
      }
    }
  }


  if (!dryRun) {
    const state = await getReleaseBranchState(repo, {
      base: baseBranch,
      branch: releaseBranch,
    })
    if (state !== 'has-bump') {
      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN is required to create the release branch')
      }
      if (state === 'at-base') {
        console.log(`Branch ${releaseBranch} exists at base HEAD with no bump; recovering by committing.`)
      }
      pkg.version = newVersion
      const nextPkg = JSON.stringify(pkg, null, 2) + '\n'
      await commitFilesToBranch(repo, {
        base: baseBranch,
        branch: releaseBranch,
        message: `v${newVersion}`,
        files: [{ path: 'package.json', content: nextPkg }],
      })
    }
  }

  const hasToken = Boolean(process.env.GITHUB_TOKEN)
  if (!hasToken && !dryRun) throw new Error('GITHUB_TOKEN is required to create or update the PR')

  const cutoff = latestTag
    ? git('log', '-1', '--format=%aI', latestTag.ref)
    : null

  // Contributor + existing-PR lookups hit public endpoints, so they work
  // unauthenticated against public repos. We still benefit from a token
  // (5000 req/h vs 60), but don't require one for previews.
  const contributors = await getContributors(commits, repo, cutoff)
  const newContributors = contributors.filter(c => c.isFirstTime)

  const existing = await gh<Array<{ number: number, body: string | null }>>(
    `/repos/${repo.owner}/${repo.repo}/pulls?head=${repo.owner}:${releaseBranch}&state=open`,
  )
  const currentPR = existing[0]
  const preamble = currentPR?.body?.replace(/## 👉 Changelog[\s\S]*$/, '').trim()
    || seedPreamble
    || `> v${newVersion} is the next ${bump} release.\n>\n> **Timetable**: to be announced.`

  const body = [
    preamble,
    '',
    '## 👉 Changelog',
    '',
    changelog,
    ...(newContributors.length
      ? [
        '',
        '### 🎉 New Contributors',
        '',
        newContributors.map(c => `- ${c.name} (@${c.username})`).join('\n'),
      ]
      : []),
    '',
    '### ❤️ Contributors',
    '',
    contributors.length
      ? contributors.map(c => `- ${c.name} (@${c.username})`).join('\n')
      : '_no contributors yet_',
  ].join('\n')

  if (dryRun) {
    console.log('\n--- DRY RUN: PR body ---\n')
    console.log(body)
    return
  }

  if (currentPR) {
    await gh(`/repos/${repo.owner}/${repo.repo}/pulls/${currentPR.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
      requireAuth: true,
    })
    console.log(`Updated PR #${currentPR.number}`)
  } else {
    const created = await gh<{ number: number, html_url: string }>(
      `/repos/${repo.owner}/${repo.repo}/pulls`,
      {
        method: 'POST',
        requireAuth: true,
        body: JSON.stringify({
          title: `v${newVersion}`,
          head: releaseBranch,
          base: baseBranch,
          body,
          draft: true,
        }),
      },
    )
    console.log(`Created PR #${created.number}: ${created.html_url}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
