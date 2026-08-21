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
//   PACKAGES           newline-separated list of publishable workspace
//                      paths/globs; when set, the release bumps every
//                      resolved workspace's package.json in lockstep
//   PRERELEASE         one-shot prerelease identifier (e.g. "beta", "rc",
//                      "0"); when set, the release cuts or continues a
//                      prerelease instead of a stable version
//   MODE               "lockstep" (default) or "independent"; independent
//                      mode computes a per-package release plan instead of
//                      bumping every workspace to one shared version
//   SCOPES             newline-separated "<package-name>: <scope> ..."
//                      overrides for routing commit scopes to workspaces
//                      in independent mode

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { makePkgFormatter } from './pkg-format.ts'

import { buildScopeMap, parseScopesInput, resolveCurrentVersion, resolveWorkspaces, type Workspace } from './_workspaces.ts'
import { buildDependencyGraph, propagateReleases, type BumpLevel } from './_dependency-graph.ts'

export interface Commit {
  hash: string
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

export interface Tag { name: string, ref: string }

function getAllTags (): string[] {
  try {
    return execFileSync(
      'git',
      ['for-each-ref', '--sort=-creatordate', '--format=%(refname:strip=2)', 'refs/tags'],
      { encoding: 'utf8' },
    ).split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function getLatestTag (): Tag | null {
  // Pick the most recent semver-shaped tag by creation date. We deliberately
  // don't use `git describe`, which only finds tags reachable from HEAD; the
  // previous release tag isn't always an ancestor of HEAD (e.g. release
  // branches that were never merged back).
  //
  // We return both the short name (for display / URLs) and the fully
  // qualified ref (`refs/tags/...`) so subsequent git calls aren't confused
  // by branches sharing the tag name.
  const name = getAllTags().find(t => /^v?\d+\.\d+\.\d+/.test(t))
  return name ? { name, ref: `refs/tags/${name}` } : null
}

// Numeric semver comparison over the `X.Y.Z` core, with a bare version
// sorting above any suffixed one (prerelease or build metadata) at the
// same core. Suffixes at the same core version are not further ordered;
// tag selection only needs "highest stable wins", not full semver
// precedence.
function compareVersions (a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)!
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== '' }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! !== pb.core[i]!) return pa.core[i]! - pb.core[i]!
  }
  return Number(pb.pre) - Number(pa.pre)
}

function highestVersionTag (tags: string[], extractVersion: (tag: string) => string | null): Tag | null {
  let best: { name: string, version: string } | null = null
  for (const tag of tags) {
    const version = extractVersion(tag)
    if (version === null) continue
    if (!best || compareVersions(version, best.version) > 0) best = { name: tag, version }
  }
  return best ? { name: best.name, ref: `refs/tags/${best.name}` } : null
}

/**
 * Latest release tag for a specific package, using the `<name>@X.Y.Z`
 * convention (`fontaine@0.8.0`, `@nuxt/kit@5.0.0`). "Latest" means the
 * highest version by numeric semver comparison, regardless of the order
 * `tags` is supplied in: tag creation date can diverge from version order
 * (retagging, backported releases, tag imports). Bare version-shaped tags
 * (`0.2.3`) and lockstep tags (`v0.6.0`) never match a package.
 */
export function latestTagForPackage (pkgName: string, tags: string[]): Tag | null {
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}@(\\d+\\.\\d+\\.\\d+(?:[-+].*)?)$`)
  return highestVersionTag(tags, tag => tag.match(re)?.[1] ?? null)
}

/**
 * Latest lockstep `vX.Y.Z` tag. Used as the commit-range fallback for a
 * package with no `<name>@*` tag yet, i.e. the first independent release
 * after a lockstep history. "Latest" is the highest version by numeric
 * semver comparison, not list order. Bare version-shaped tags are
 * deliberately excluded: they can't be attributed to any package or
 * release mode.
 */
export function latestLockstepTag (tags: string[]): Tag | null {
  return highestVersionTag(tags, tag => tag.match(/^v(\d+\.\d+\.\d+(?:[-+].*)?)$/)?.[1] ?? null)
}

function parseCommit (raw: string): Commit | null {
  const [hash, shortHash, authorName, authorEmail, subject, body] = raw.split('\x1f')
  if (!hash || !shortHash || !subject) return null

  const header = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/)
  if (!header) {
    return {
      hash,
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
    hash,
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
    ['log', range, `--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%s%x1f%b%x1e`],
    { encoding: 'utf8' },
  )
  return stdout
    .split('\x1e')
    .map(s => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map(parseCommit)
    .filter((c): c is Commit => c !== null)
}

export function determineBump (commits: Commit[]): BumpLevel {
  if (commits.some(c => c.isBreaking)) return 'major'
  if (commits.some(c => c.type === 'feat')) return 'minor'
  return 'patch'
}

export function incVersion (version: string, bump: 'major' | 'minor' | 'patch', prerelease?: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-zA-Z.-]+))?$/)
  if (!match) {
    throw new Error(
      `Cannot bump version "${version}": expected strict "X.Y.Z" semver, optionally with a prerelease suffix. uppt does not support build-metadata versions.`,
    )
  }

  let [x, y, z] = match.slice(1, 4).map(Number) as [number, number, number]
  const currentPre = match[4]

  const bumpBase = () => {
    if (x === 0) {
      if (bump === 'major') { bump = 'minor' }
      else if (bump === 'minor') { bump = 'patch' }
    }
    if (bump === 'major') { x += 1; y = 0; z = 0 }
    else if (bump === 'minor') { y += 1; z = 0 }
    else { z += 1 }
  }

  if (prerelease === undefined) {
    // A prerelease already reserved its target version, so graduating it
    // drops the suffix without a further bump: `feat:` on `5.0.0-0` must
    // produce `5.0.0`, not `5.1.0`.
    if (currentPre === undefined) bumpBase()
    return `${x}.${y}.${z}`
  }

  // The identifier flows into branch/ref names and, downstream, gh argv;
  // pin it to a safe alphabet to rule out flag injection and ref confusion.
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(prerelease)) {
    throw new Error(
      `Invalid prerelease identifier "${prerelease}": expected lowercase alphanumerics, "." or "-" after the first character (e.g. "beta", "rc", "0").`,
    )
  }

  const isBareNumber = /^\d+$/.test(prerelease)

  if (currentPre === undefined) {
    bumpBase()
    return isBareNumber ? `${x}.${y}.${z}-0` : `${x}.${y}.${z}-${prerelease}.0`
  }

  // A bare-number identifier is a style selector for the `-N` form, not a
  // counter seed: new lines always start at 0.
  if (isBareNumber) {
    return /^\d+$/.test(currentPre)
      ? `${x}.${y}.${z}-${Number(currentPre) + 1}`
      : `${x}.${y}.${z}-0`
  }

  const dot = currentPre.lastIndexOf('.')
  const head = dot === -1 ? currentPre : currentPre.slice(0, dot)
  const tail = dot === -1 ? '' : currentPre.slice(dot + 1)
  if (head === prerelease && /^\d+$/.test(tail)) {
    return `${x}.${y}.${z}-${prerelease}.${Number(tail) + 1}`
  }
  return `${x}.${y}.${z}-${prerelease}.0`
}

export interface PackageRelease {
  /** Package name, as declared in its `package.json`. */
  name: string
  /** The resolved workspace record. */
  workspace: Workspace
  /**
   * The tag this package's changelog range starts from: its latest
   * `<name>@X.Y.Z` tag, else the latest lockstep `vX.Y.Z` tag, else
   * `null` when the repo has neither (full history).
   */
  fromTag: Tag | null
  /** Version in the workspace `package.json` right now. */
  currentVersion: string
  /** Version this release bumps the package to. */
  newVersion: string
  bump: BumpLevel
  /**
   * `true` when the package releases on its own routed commits;
   * `false` when it releases only because a `workspace:` dependency
   * was bumped.
   */
  ownCommits: boolean
  /** Commits routed to this package. Empty for propagated-only releases. */
  commits: Commit[]
}

export interface IndependentReleasePlan {
  /** Packages to release, in topological (publish) order. */
  releases: PackageRelease[]
  /** Commits with no scope, or a scope no package claims. They bump nothing. */
  unrouted: Commit[]
}

/**
 * Compute the per-package release plan for independent-versioning mode.
 *
 * `commits` is the union commit range covering every package's last
 * release; `isCommitSince` narrows it per package (a commit already
 * shipped in `fontaine@0.8.0` must not count toward fontaine again just
 * because fontless released longer ago). When omitted, every commit
 * counts for every package.
 */
export function computeIndependentPlan (opts: {
  workspaces: Workspace[]
  /** `scopes:` input overrides, from `parseScopesInput`. */
  scopeOverrides: Map<string, string[]>
  /** All tag names, sorted newest-first. */
  tags: string[]
  /** Commits over the union range, already filtered to release-worthy types. */
  commits: Commit[]
  isCommitSince?: (commit: Commit, tag: Tag) => boolean
  prerelease?: string
}): IndependentReleasePlan {
  const scopeMap = buildScopeMap(opts.workspaces, opts.scopeOverrides)

  const routed = new Map<string, Commit[]>(opts.workspaces.map(ws => [ws.name, []]))
  const unrouted: Commit[] = []
  for (const commit of opts.commits) {
    const ws = commit.scope ? scopeMap.resolve(commit.scope) : null
    if (ws) routed.get(ws.name)!.push(commit)
    else unrouted.push(commit)
  }

  const lockstepTag = latestLockstepTag(opts.tags)
  const fromTags = new Map<string, Tag | null>()
  const planned: Array<{ name: string, bump: BumpLevel }> = []
  for (const ws of opts.workspaces) {
    const fromTag = latestTagForPackage(ws.name, opts.tags) ?? lockstepTag
    fromTags.set(ws.name, fromTag)
    const commits = (fromTag && opts.isCommitSince)
      ? routed.get(ws.name)!.filter(c => opts.isCommitSince!(c, fromTag))
      : routed.get(ws.name)!
    routed.set(ws.name, commits)
    if (commits.length) planned.push({ name: ws.name, bump: determineBump(commits) })
  }

  const graph = buildDependencyGraph(opts.workspaces)
  const byName = new Map(opts.workspaces.map(ws => [ws.name, ws]))
  const releases = propagateReleases(graph, planned).map((release) => {
    const workspace = byName.get(release.name)!
    if (!workspace.version) {
      throw new Error(`Cannot release "${release.name}": its package.json has no \`version\` field.`)
    }
    return {
      name: release.name,
      workspace,
      fromTag: fromTags.get(release.name)!,
      currentVersion: workspace.version,
      newVersion: incVersion(workspace.version, release.bump, opts.prerelease),
      bump: release.bump,
      ownCommits: release.ownCommits,
      commits: release.ownCommits ? routed.get(release.name)! : [],
    }
  })

  return { releases, unrouted }
}

export function formatChangelog (
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

/** Create a tree layering `files` over `baseTree`, returning its sha. */
async function createTree (
  repo: { owner: string, repo: string },
  baseTree: string,
  files: FileToCommit[],
): Promise<string> {
  const blobs = await Promise.all(files.map(async (file) => {
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
        base_tree: baseTree,
        tree: blobs.map(b => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
      }),
    },
  )
  return tree.sha
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

  const tree = await createTree(repo, parentCommit.tree.sha, opts.files)

  const commit = await gh<{ sha: string }>(
    `/repos/${repo.owner}/${repo.repo}/git/commits`,
    {
      method: 'POST',
      requireAuth: true,
      body: JSON.stringify({
        message: opts.message,
        tree,
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

export interface BranchDivergence {
  /** Files the branch changes relative to its merge base with the target base. */
  changed: Set<string>
  mergeBase: string
  behindBy: number
}

/**
 * Decide whether `opts.branch` still represents `opts.files` correctly, or
 * has to be rebuilt. Returns `null` when the branch is fine as it stands.
 *
 * A branch that is simply behind base is left alone: the diff it carries is
 * still the diff we want, and GitHub can merge it. Rebuilding is only needed
 * when the branch's own diff no longer matches the plan, or when base has
 * since touched one of the same files (which would conflict on merge).
 */
export function releaseBranchDrift (opts: {
  /** `null` when the branch doesn't exist yet. */
  divergence: BranchDivergence | null
  /** Desired file contents, keyed by repo-relative path. */
  desired: Map<string, string>
  /** Current contents of those same paths on the branch. */
  branchContents: Map<string, string | null>
  /** Desired paths that base has changed since the merge base. */
  baseTouched: string[]
}): string | null {
  if (!opts.divergence) return 'branch does not exist'

  const desiredPaths = [...opts.desired.keys()]
  const changed = opts.divergence.changed
  if (changed.size !== desiredPaths.length || desiredPaths.some(path => !changed.has(path))) {
    return `branch changes ${[...changed].join(', ') || 'nothing'}, plan changes ${desiredPaths.join(', ')}`
  }

  for (const path of desiredPaths) {
    if (opts.branchContents.get(path) !== opts.desired.get(path)) return `${path} differs from the plan`
  }

  if (opts.baseTouched.length) return `base has since changed ${opts.baseTouched.join(', ')}`

  return null
}

/**
 * Make `opts.branch` carry exactly `opts.files` as its diff against
 * `opts.base`, rebuilding it as a single commit on the base tip only when
 * that isn't already true (see `releaseBranchDrift`). A rebuild always
 * force-updates the ref straight to the new commit rather than resetting to
 * base first: a branch that momentarily equals its base makes GitHub close
 * the open PR as having nothing to merge.
 */
async function syncReleaseBranch (
  repo: { owner: string, repo: string },
  opts: { base: string, branch: string, message: string, files: FileToCommit[] },
): Promise<void> {
  if (!opts.files.length) {
    throw new Error('syncReleaseBranch: refusing to commit with no files')
  }

  const desired = new Map(opts.files.map(file => [file.path, file.content]))
  const desiredPaths = [...desired.keys()]

  let divergence: BranchDivergence | null = null
  try {
    const cmp = await gh<{ files?: Array<{ filename: string }>, merge_base_commit: { sha: string }, behind_by: number }>(
      `/repos/${repo.owner}/${repo.repo}/compare/${encodeURIComponent(opts.base)}...${encodeURIComponent(opts.branch)}`,
      { requireAuth: true },
    )
    divergence = {
      changed: new Set((cmp.files ?? []).map(file => file.filename)),
      mergeBase: cmp.merge_base_commit.sha,
      behindBy: cmp.behind_by,
    }
  } catch (err) {
    if (!(err instanceof Error) || !/-> 404\b/.test(err.message)) throw err
  }

  const branchContents = new Map<string, string | null>()
  const baseTouched: string[] = []
  if (divergence) {
    for (const path of desiredPaths) {
      branchContents.set(path, await getFileContent(repo, path, opts.branch))
    }
    if (divergence.behindBy > 0) {
      const baseCmp = await gh<{ files?: Array<{ filename: string }> }>(
        `/repos/${repo.owner}/${repo.repo}/compare/${divergence.mergeBase}...${encodeURIComponent(opts.base)}`,
        { requireAuth: true },
      )
      for (const file of baseCmp.files ?? []) {
        if (desired.has(file.filename)) baseTouched.push(file.filename)
      }
    }
  }

  const drift = releaseBranchDrift({ divergence, desired, branchContents, baseTouched })
  if (!drift) {
    console.log(`Branch ${opts.branch} already carries the release plan; leaving it untouched.`)
    return
  }
  console.log(`Rebuilding ${opts.branch} on ${opts.base}: ${drift}`)

  const baseInfo = await gh<{ commit: { sha: string } }>(
    `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(opts.base)}`,
    { requireAuth: true },
  )
  const baseSha = baseInfo.commit.sha
  const baseCommit = await gh<{ tree: { sha: string } }>(
    `/repos/${repo.owner}/${repo.repo}/git/commits/${baseSha}`,
    { requireAuth: true },
  )
  const tree = await createTree(repo, baseCommit.tree.sha, opts.files)

  const commit = await gh<{ sha: string }>(
    `/repos/${repo.owner}/${repo.repo}/git/commits`,
    {
      method: 'POST',
      requireAuth: true,
      body: JSON.stringify({ message: opts.message, tree, parents: [baseSha] }),
    },
  )

  if (divergence) {
    await gh(`/repos/${repo.owner}/${repo.repo}/git/refs/heads/${opts.branch}`, {
      method: 'PATCH',
      requireAuth: true,
      body: JSON.stringify({ sha: commit.sha, force: true }),
    })
  } else {
    await gh(`/repos/${repo.owner}/${repo.repo}/git/refs`, {
      method: 'POST',
      requireAuth: true,
      body: JSON.stringify({ ref: `refs/heads/${opts.branch}`, sha: commit.sha }),
    })
  }
}

async function getFileContent (
  repo: { owner: string, repo: string },
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const data = await gh<{ content?: string, encoding?: string }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
      { requireAuth: true },
    )
    if (data.encoding !== 'base64' || typeof data.content !== 'string') return null
    return Buffer.from(data.content, 'base64').toString('utf8')
  } catch (err) {
    if (err instanceof Error && /-> 404\b/.test(err.message)) return null
    throw err
  }
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
    return prs.some(pr => pr.merged_at && (pr.head.ref.startsWith('release/v') || /^release\/.+-pending$/.test(pr.head.ref)))
  } catch {
    return false
  }
}

/**
 * Build the set of `package.json` files to write in the release commit.
 *
 * Single-package mode: just the root, bumped to `newVersion`.
 *
 * Monorepo mode: every listed workspace is rewritten to `newVersion`.
 * The root is included only if its current `version` exactly matches
 * the lockstep version; otherwise it's left untouched (it might be
 * `0.0.0`, absent, or deliberately frozen, and none of those are uppt's
 * business).
 */
export function buildBumpFileSet (opts: {
  monorepo: boolean
  workspaces: Workspace[]
  rootPkg: Record<string, unknown>
  rootPkgSource: string
  currentVersion: string
  newVersion: string
}): Array<{ path: string, content: string }> {
  const files: Array<{ path: string, content: string }> = []
  const formatRootPkg = makePkgFormatter(opts.rootPkgSource)

  if (!opts.monorepo) {
    const updated = { ...opts.rootPkg, version: opts.newVersion }
    files.push({ path: 'package.json', content: formatRootPkg(updated) })
    return files
  }

  let rootCoveredByWorkspaces = false
  for (const ws of opts.workspaces) {
    const wsPkg = { ...ws.pkg, version: opts.newVersion }
    const path = ws.relDir === '.' ? 'package.json' : `${ws.relDir}/package.json`
    if (path === 'package.json') rootCoveredByWorkspaces = true
    files.push({ path, content: makePkgFormatter(ws.source)(wsPkg) })
  }

  if (!rootCoveredByWorkspaces && opts.rootPkg.version === opts.currentVersion) {
    const updated = { ...opts.rootPkg, version: opts.newVersion }
    files.push({ path: 'package.json', content: formatRootPkg(updated) })
  }

  return files
}

/**
 * Build the set of `package.json` files to write in an independent-mode
 * release commit: exactly the planned releases' manifests, each bumped
 * to its own `newVersion`. `workspace:` specifiers are left as-is (the
 * package manager resolves them at pack time), and the root manifest is
 * only included if it is itself a planned release.
 */
export function buildIndependentBumpFileSet (plan: IndependentReleasePlan): FileToCommit[] {
  return plan.releases.map((release) => {
    const pkg = { ...release.workspace.pkg, version: release.newVersion }
    const path = release.workspace.relDir === '.' ? 'package.json' : `${release.workspace.relDir}/package.json`
    return { path, content: makePkgFormatter(release.workspace.source)(pkg) }
  })
}

/**
 * Maintainer-editable preamble of a release PR body: everything above
 * the first generated `## 👉` heading. Returns `null` when the body is
 * empty or starts with a generated heading.
 */
export function extractPreamble (body: string | null | undefined): string | null {
  if (!body) return null
  const match = body.match(/^## 👉 .*$/m)
  const preamble = (match ? body.slice(0, match.index) : body).trim()
  return preamble || null
}

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

function propagationCauses (release: PackageRelease, releasedNames: Set<string>): string[] {
  const causes = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    const deps = release.workspace.pkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
      if (dep !== release.name && releasedNames.has(dep)) causes.add(dep)
    }
  }
  return [...causes]
}

/**
 * Render the full body of an independent-mode release PR from the plan.
 * The body is regenerated wholesale on every push (only the preamble
 * carries over), so packages that drop out of the plan disappear.
 */
export function buildIndependentBody (
  plan: IndependentReleasePlan,
  opts: {
    owner: string
    repo: string
    /** Release branch name, used as the `compare` target for changelog links. */
    branch: string
    preamble: string
    contributors?: Contributor[]
  },
): string {
  const releasedNames = new Set(plan.releases.map(r => r.name))
  const lines: string[] = [opts.preamble, '', '## 👉 Pending releases', '']

  for (const release of plan.releases) {
    const suffix = release.ownCommits ? '' : ', dependency bump only'
    lines.push(`- ${release.name}: ${release.currentVersion} → ${release.newVersion} (${release.bump}${suffix})`)
  }

  lines.push('', '## 👉 Changelog', '')
  for (const release of plan.releases) {
    lines.push(`### ${release.name} (${release.currentVersion} → ${release.newVersion})`, '')
    if (release.ownCommits) {
      lines.push(formatChangelog(release.commits, {
        owner: opts.owner,
        repo: opts.repo,
        fromRef: release.fromTag,
        toRef: opts.branch,
      }), '')
    } else {
      const causes = propagationCauses(release, releasedNames)
      const note = causes.length
        ? `_Released because ${causes.map(c => `\`${c}\``).join(' and ')} was bumped; no direct changes._`
        : '_Released because a `workspace:` dependency was bumped; no direct changes._'
      lines.push(note, '')
    }
  }

  if (plan.unrouted.length) {
    const commitUrl = (sha: string) => `https://github.com/${opts.owner}/${opts.repo}/commit/${sha}`
    lines.push('### 📝 Other commits', '', '_These commits were not routed to any package and do not bump any version._', '')
    for (const c of plan.unrouted) {
      lines.push(`- ${c.message} ([\`${c.shortHash}\`](${commitUrl(c.shortHash)}))`)
    }
    lines.push('')
  }

  if (opts.contributors) {
    const newContributors = opts.contributors.filter(c => c.isFirstTime)
    if (newContributors.length) {
      lines.push('### 🎉 New Contributors', '', newContributors.map(c => `- ${c.name} (@${c.username})`).join('\n'), '')
    }
    lines.push(
      '### ❤️ Contributors',
      '',
      opts.contributors.length
        ? opts.contributors.map(c => `- ${c.name} (@${c.username})`).join('\n')
        : '_no contributors yet_',
    )
  }

  return lines.join('\n').trimEnd()
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

  const packagesInput = process.env.PACKAGES?.trim() ?? ''
  const monorepo = packagesInput.length > 0

  const mode = process.env.MODE?.trim() || 'lockstep'
  if (mode !== 'lockstep' && mode !== 'independent') {
    throw new Error(`Invalid \`mode\` input "${mode}": expected "lockstep" or "independent".`)
  }
  if (mode === 'independent') {
    if (!monorepo) {
      throw new Error('`mode: independent` requires the `packages` input.')
    }
    await runIndependent(packagesInput)
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

  const workspaces: Workspace[] = monorepo
    ? resolveWorkspaces(process.cwd(), packagesInput)
    : []

  const rootPkgPath = resolve(process.cwd(), 'package.json')
  const rootPkgSource = readFileSync(rootPkgPath, 'utf8')
  const rootPkg = JSON.parse(rootPkgSource)

  const currentVersion = resolveCurrentVersion(process.cwd(), packagesInput)

  const bump = determineBump(commits)
  const prerelease = process.env.PRERELEASE?.trim() || undefined
  const newVersion = incVersion(currentVersion, bump, prerelease)
  const releaseBranch = `release/v${newVersion}`

  const changelog = formatChangelog(commits, {
    owner: repo.owner,
    repo: repo.repo,
    fromRef: latestTag,
    toRef: releaseBranch,
  })

  console.log(`Current: ${currentVersion}  ->  ${newVersion} (${bump})`)
  if (monorepo) {
    console.log(`Workspaces (${workspaces.length}): ${workspaces.map(ws => ws.name).join(', ')}`)
  }
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
        && (pr.head.ref.startsWith('release/v') || pr.head.ref === `release/${baseBranch}-pending`)
        && pr.head.ref !== releaseBranch
        && pr.base.ref === baseBranch,
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    for (const pr of stale) {
      console.log(`Closing superseded release PR #${pr.number} (${pr.head.ref})`)
      const preamble = extractPreamble(pr.body)
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
      const files = buildBumpFileSet({
        monorepo,
        workspaces,
        rootPkg,
        rootPkgSource,
        currentVersion,
        newVersion,
      })
      await commitFilesToBranch(repo, {
        base: baseBranch,
        branch: releaseBranch,
        message: `v${newVersion}`,
        files,
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
  const preamble = extractPreamble(currentPR?.body)
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

async function runIndependent (packagesInput: string): Promise<void> {
  const workspaces = resolveWorkspaces(process.cwd(), packagesInput)
  const scopeOverrides = parseScopesInput(process.env.SCOPES ?? '')
  const tags = getAllTags()

  const lockstepTag = latestLockstepTag(tags)
  const fromTags = workspaces.map(ws => latestTagForPackage(ws.name, tags) ?? lockstepTag)

  // One `git log` over the union range: the oldest per-package boundary,
  // i.e. the highest index in the newest-first tag list. Any package with
  // no boundary at all forces full history.
  let unionFrom: Tag | null = null
  if (fromTags.every(t => t !== null)) {
    let oldestIndex = -1
    for (const tag of fromTags) {
      const index = tags.indexOf(tag!.name)
      if (index > oldestIndex) {
        oldestIndex = index
        unionFrom = tag
      }
    }
  }

  const commits = getCommitsSince(unionFrom).filter(
    c => KNOWN_TYPES.has(c.type) && !(c.type === 'chore' && c.scope === 'deps'),
  )

  const sinceSets = new Map<string, Set<string>>()
  const isCommitSince = (commit: Commit, tag: Tag): boolean => {
    let set = sinceSets.get(tag.ref)
    if (!set) {
      set = new Set(git('rev-list', `${tag.ref}..HEAD`).split('\n').filter(Boolean))
      sinceSets.set(tag.ref, set)
    }
    return set.has(commit.hash)
  }

  const plan = computeIndependentPlan({
    workspaces,
    scopeOverrides,
    tags,
    commits,
    isCommitSince,
    prerelease: process.env.PRERELEASE?.trim() || undefined,
  })

  if (plan.unrouted.length) {
    console.log(`Other commits (${plan.unrouted.length}, bump nothing):`)
    for (const commit of plan.unrouted) {
      console.log(`  ${commit.shortHash} ${commit.message}`)
    }
  }
  if (!plan.releases.length) {
    console.log('Independent release plan: no packages to release.')
    return
  }

  console.log(`Independent release plan (${plan.releases.length} package${plan.releases.length === 1 ? '' : 's'}):`)
  for (const release of plan.releases) {
    const reason = release.ownCommits
      ? `${release.commits.length} commit${release.commits.length === 1 ? '' : 's'}`
      : 'dependency bump only'
    const from = release.fromTag ? ` since ${release.fromTag.name}` : ''
    console.log(`  ${release.name}: ${release.currentVersion} -> ${release.newVersion} (${release.bump}, ${reason}${from})`)
  }

  const dryRun = Boolean(process.env.DRY_RUN)
  const repo = getRepo()
  const baseBranch = getCurrentBranch()
  const releaseBranch = `release/${baseBranch}-pending`
  const title = `chore: release ${plan.releases.length} package${plan.releases.length === 1 ? '' : 's'}`

  console.log(`Base branch: ${baseBranch}`)
  console.log(`Release branch: ${releaseBranch}`)

  // A stale lockstep PR (`release/vX.Y.Z`) on the same base means the repo
  // switched to independent mode with a lockstep release still open; the two
  // would bump the same manifests to conflicting versions, so close it and
  // lift its preamble into the pending PR.
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
        && pr.base.ref === baseBranch,
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    for (const pr of stale) {
      console.log(`Closing superseded release PR #${pr.number} (${pr.head.ref})`)
      const preamble = extractPreamble(pr.body)
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
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN is required to create the release branch')
    }
    // The pending branch name never changes, but the plan behind it does
    // (packages join and drop as commits land on base), so the branch has to
    // end up carrying exactly the current plan and nothing stale.
    await syncReleaseBranch(repo, {
      base: baseBranch,
      branch: releaseBranch,
      message: title,
      files: buildIndependentBumpFileSet(plan),
    })
  }

  const hasToken = Boolean(process.env.GITHUB_TOKEN)
  if (!hasToken && !dryRun) throw new Error('GITHUB_TOKEN is required to create or update the PR')

  const ownCommits = plan.releases.flatMap(r => r.commits)
  const seen = new Set<string>()
  const uniqueCommits = ownCommits.filter(c => !seen.has(c.hash) && Boolean(seen.add(c.hash)))
  const cutoff = unionFrom ? git('log', '-1', '--format=%aI', unionFrom.ref) : null
  const contributors = await getContributors(uniqueCommits, repo, cutoff)

  const existing = await gh<Array<{ number: number, body: string | null }>>(
    `/repos/${repo.owner}/${repo.repo}/pulls?head=${repo.owner}:${releaseBranch}&state=open`,
  )
  const currentPR = existing[0]
  const preamble = extractPreamble(currentPR?.body)
    || seedPreamble
    || `> The next set of package releases, covering all packages with unreleased changes.\n>\n> **Timetable**: to be announced.`

  const body = buildIndependentBody(plan, {
    owner: repo.owner,
    repo: repo.repo,
    branch: releaseBranch,
    preamble,
    contributors,
  })

  if (dryRun) {
    console.log('\n--- DRY RUN: PR body ---\n')
    console.log(body)
    return
  }

  if (currentPR) {
    await gh(`/repos/${repo.owner}/${repo.repo}/pulls/${currentPR.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, body }),
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
          title,
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

// Run as a script, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
