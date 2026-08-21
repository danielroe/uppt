import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))

const { main } = await import('../scripts/update-changelog.ts')

const ENV_KEYS = [
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'DRY_RUN',
  'RELEASE_BASE',
  'PACKAGES',
  'PRERELEASE',
  'MODE',
  'SCOPES',
] as const

interface FakeCommit {
  hash: string
  short: string
  name: string
  email: string
  subject: string
  body?: string
}

interface FakePR {
  number: number
  body: string | null
  head: { ref: string, repo: { full_name: string } | null }
  base: { ref: string }
  updated_at: string
}

interface ApiCall { method: string, path: string, body?: unknown }

const HEAD_SHA = '0'.repeat(40)

let tmp: string
let cwd: string
let env: NodeJS.ProcessEnv
let calls: ApiCall[]

const git = {
  tags: [] as string[],
  commits: [] as FakeCommit[],
  revList: [] as string[],
  remote: 'git@github.com:owner/repo.git',
  branch: 'main',
}

const api = {
  branches: new Map<string, string>(),
  openPRs: [] as FakePR[],
  prsForHead: [] as Array<{ head: { ref: string }, merged_at: string | null }>,
  logins: new Map<string, string | null>(),
  priorCommits: new Map<string, unknown[]>(),
  compares: new Map<string, { files?: Array<{ filename: string }>, merge_base_commit: { sha: string }, behind_by: number }>(),
  contents: new Map<string, string>(),
  rawContents: new Map<string, unknown>(),
  fail: new Map<string, number>(),
  /** Fail the Nth (1-based) call to a `METHOD /path` pair, letting earlier ones through. */
  failNth: new Map<string, { nth: number, status: number }>(),
  seen: new Map<string, number>(),
}

function record (...commits: FakeCommit[]): string {
  return commits
    .map(c => [c.hash, c.short, c.name, c.email, c.subject, c.body ?? ''].join('\x1f') + '\x1e')
    .join('')
}

function stubGit () {
  execFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd !== 'git') throw new Error(`unexpected command ${cmd}`)
    const [sub] = args
    if (sub === 'for-each-ref') return git.tags.join('\n') + '\n'
    if (sub === 'remote') return git.remote
    if (sub === 'rev-parse') return args.includes('--abbrev-ref') ? git.branch : HEAD_SHA
    if (sub === 'rev-list') return git.revList.join('\n')
    if (sub === 'log' && args[1] === '-1') return '2024-01-01T00:00:00Z'
    if (sub === 'log') return record(...git.commits)
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

/** Minimal in-memory GitHub REST API over the endpoints the script uses. */
function route (method: string, path: string, body: unknown): { status: number, body: unknown } {
  const key = `${method} ${path.split('?')[0]}`
  const forced = api.fail.get(key)
  if (forced) return { status: forced, body: { message: 'forced failure' } }

  const count = (api.seen.get(key) ?? 0) + 1
  api.seen.set(key, count)
  const transient = api.failNth.get(key)
  if (transient && transient.nth === count) return { status: transient.status, body: { message: 'transient failure' } }

  const [pathname, query = ''] = path.split('?')
  const rest = pathname!.replace('/repos/owner/repo', '')
  const params = new URLSearchParams(query)

  if (method === 'GET' && /^\/commits\/[^/]+\/pulls$/.test(rest)) return { status: 200, body: api.prsForHead }
  if (method === 'GET' && rest === '/commits') {
    return { status: 200, body: api.priorCommits.get(params.get('author')!) ?? [] }
  }
  if (method === 'GET' && /^\/commits\/[^/]+$/.test(rest)) {
    const login = api.logins.get(decodeURIComponent(rest.slice('/commits/'.length)))
    if (login === undefined) return { status: 404, body: {} }
    return { status: 200, body: { author: login === null ? null : { login } } }
  }
  if (method === 'GET' && rest === '/pulls') {
    const head = params.get('head')
    if (head && head !== 'owner:') {
      const branch = head.slice('owner:'.length)
      return { status: 200, body: api.openPRs.filter(pr => pr.head.ref === branch) }
    }
    return { status: 200, body: api.openPRs }
  }
  if (method === 'POST' && rest === '/pulls') {
    return { status: 201, body: { number: 42, html_url: 'https://github.com/owner/repo/pull/42' } }
  }
  if (method === 'PATCH' && /^\/pulls\/\d+$/.test(rest)) return { status: 200, body: {} }
  if (method === 'GET' && rest.startsWith('/branches/')) {
    const branch = decodeURIComponent(rest.slice('/branches/'.length))
    const sha = api.branches.get(branch)
    return sha ? { status: 200, body: { commit: { sha } } } : { status: 404, body: { message: 'Branch not found' } }
  }
  if (method === 'GET' && rest.startsWith('/git/commits/')) {
    return { status: 200, body: { tree: { sha: `tree-of-${rest.slice('/git/commits/'.length)}` } } }
  }
  if (method === 'POST' && rest === '/git/blobs') return { status: 201, body: { sha: 'blob-sha' } }
  if (method === 'POST' && rest === '/git/trees') return { status: 201, body: { sha: 'tree-sha' } }
  if (method === 'POST' && rest === '/git/commits') return { status: 201, body: { sha: 'commit-sha' } }
  if (method === 'POST' && rest === '/git/refs') return { status: 201, body: {} }
  if (rest.startsWith('/git/refs/heads/')) {
    if (method === 'PATCH') {
      api.branches.set(rest.slice('/git/refs/heads/'.length), (body as { sha: string }).sha)
      return { status: 200, body: {} }
    }
    if (method === 'DELETE') return { status: 204, body: {} }
  }
  if (method === 'GET' && rest.startsWith('/compare/')) {
    const cmp = api.compares.get(decodeURIComponent(rest.slice('/compare/'.length)))
    return cmp ? { status: 200, body: cmp } : { status: 404, body: { message: 'Not Found' } }
  }
  if (method === 'GET' && rest.startsWith('/contents/')) {
    const contentKey = `${params.get('ref')}:${decodeURIComponent(rest.slice('/contents/'.length))}`
    if (api.rawContents.has(contentKey)) return { status: 200, body: api.rawContents.get(contentKey) }
    const content = api.contents.get(contentKey)
    if (content === undefined) return { status: 404, body: { message: 'Not Found' } }
    return { status: 200, body: { encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') } }
  }
  throw new Error(`unrouted API call: ${method} ${path}`)
}

function stubFetch () {
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const path = url.replace('https://api.github.com', '')
    const body = init.body ? JSON.parse(init.body as string) : undefined
    calls.push({ method, path, body })
    const { status, body: payload } = route(method, path, body)
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    })
  }))
}

function writePackage (relDir: string, contents: Record<string, unknown>) {
  const dir = resolve(tmp, relDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(contents, null, 2) + '\n')
}

function committedFiles (): Array<{ path: string, sha: string }> {
  const tree = calls.find(call => call.method === 'POST' && call.path.endsWith('/git/trees'))
  return (tree?.body as { tree: Array<{ path: string, sha: string }> } | undefined)?.tree ?? []
}

function blobContents (): string[] {
  return calls
    .filter(call => call.method === 'POST' && call.path.endsWith('/git/blobs'))
    .map(call => Buffer.from((call.body as { content: string }).content, 'base64').toString('utf8'))
}

function prBody (): string {
  const call = calls.findLast(c => (c.method === 'POST' && c.path.endsWith('/pulls')) || (c.method === 'PATCH' && /\/pulls\/\d+$/.test(c.path)))
  return (call?.body as { body: string }).body
}

const FEAT: FakeCommit = { hash: 'a'.repeat(40), short: 'aaaaaaa', name: 'Ada', email: 'ada@example.com', subject: 'feat: add a thing (#7)' }

beforeEach(() => {
  env = { ...process.env }
  cwd = process.cwd()
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.GITHUB_REPOSITORY = 'owner/repo'
  process.env.GITHUB_TOKEN = 'tok'
  tmp = mkdtempSync(resolve(tmpdir(), 'uppt-main-'))
  process.chdir(tmp)
  writePackage('.', { name: 'pkg', version: '1.2.3' })

  git.tags = ['v1.2.3']
  git.commits = [FEAT]
  git.revList = [FEAT.hash]
  git.remote = 'git@github.com:owner/repo.git'
  git.branch = 'main'

  api.branches = new Map([['main', 'base-sha']])
  api.openPRs = []
  api.prsForHead = []
  api.logins = new Map([['aaaaaaa', 'ada']])
  api.priorCommits = new Map()
  api.compares = new Map()
  api.contents = new Map()
  api.rawContents = new Map()
  api.fail = new Map()
  api.failNth = new Map()
  api.seen = new Map()

  calls = []
  stubGit()
  stubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  process.chdir(cwd)
  process.env = env
  execFileSync.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('lockstep main', () => {
  it('creates a release branch and a draft PR', async () => {
    await main()
    expect(committedFiles()).toEqual([{ path: 'package.json', mode: '100644', type: 'blob', sha: 'blob-sha' }])
    expect(JSON.parse(blobContents()[0]!)).toMatchObject({ version: '1.3.0' })
    const created = calls.find(c => c.method === 'POST' && c.path.endsWith('/pulls'))!
    expect(created.body).toMatchObject({ title: 'v1.3.0', head: 'release/v1.3.0', base: 'main', draft: true })
    expect(prBody()).toContain('### 🚀 Enhancements')
    expect(prBody()).toContain('- add a thing (#7)')
    expect(prBody()).toContain('- Ada (@ada)')
  })

  it('skips when HEAD is the merge of a release PR', async () => {
    api.prsForHead = [{ head: { ref: 'release/v1.2.3' }, merged_at: '2024-01-01T00:00:00Z' }]
    await main()
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('skips when HEAD is the merge of a pending release PR', async () => {
    api.prsForHead = [{ head: { ref: 'release/main-pending' }, merged_at: '2024-01-01T00:00:00Z' }]
    await main()
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('carries on when the merged-PR lookup fails', async () => {
    api.fail.set(`GET /repos/owner/repo/commits/${HEAD_SHA}/pulls`, 500)
    await main()
    expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/pulls'))).toBe(true)
  })

  it('rejects an unknown mode', async () => {
    process.env.MODE = 'sideways'
    await expect(main()).rejects.toThrow(/expected "lockstep" or "independent"/)
  })

  it('requires packages for independent mode', async () => {
    process.env.MODE = 'independent'
    await expect(main()).rejects.toThrow(/requires the `packages` input/)
  })

  it('does nothing when there are no release-worthy commits', async () => {
    git.commits = [{ ...FEAT, subject: 'chore(deps): bump something' }]
    await main()
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('reports the repo root when there is no tag at all', async () => {
    git.tags = []
    git.commits = []
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main()
    expect(log).toHaveBeenCalledWith('No release-worthy commits since', 'repo root')
  })

  it('reads the repo from the origin remote when the env var is absent', async () => {
    delete process.env.GITHUB_REPOSITORY
    await main()
    expect(calls[0]!.path).toMatch(/^\/repos\/owner\/repo\//)
  })

  it('throws when the origin remote is unparseable', async () => {
    delete process.env.GITHUB_REPOSITORY
    git.remote = 'not-a-remote-url'
    await expect(main()).rejects.toThrow(/Cannot parse repo from remote url/)
  })

  it('honours RELEASE_BASE over the checked-out branch', async () => {
    process.env.RELEASE_BASE = '4.x'
    api.branches.set('4.x', 'four-sha')
    await main()
    const created = calls.find(c => c.method === 'POST' && c.path.endsWith('/pulls'))!
    expect(created.body).toMatchObject({ base: '4.x' })
  })

  it('closes a superseded release PR and lifts its preamble', async () => {
    api.openPRs = [{
      number: 3,
      body: '> old intro\n\n## 👉 Changelog\n\nstuff',
      head: { ref: 'release/v1.2.4', repo: { full_name: 'owner/repo' } },
      base: { ref: 'main' },
      updated_at: '2024-01-02T00:00:00Z',
    }]
    await main()
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'PATCH', path: '/repos/owner/repo/pulls/3', body: { state: 'closed' } }),
      expect.objectContaining({ method: 'DELETE', path: '/repos/owner/repo/git/refs/heads/release/v1.2.4' }),
    ]))
    expect(prBody()).toContain('> old intro')
  })

  it('warns but continues when the superseded branch cannot be deleted', async () => {
    api.openPRs = [{
      number: 3,
      body: null,
      head: { ref: 'release/v1.2.4', repo: { full_name: 'owner/repo' } },
      base: { ref: 'main' },
      updated_at: '2024-01-02T00:00:00Z',
    }]
    api.fail.set('DELETE /repos/owner/repo/git/refs/heads/release/v1.2.4', 422)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await main()
    expect(warn).toHaveBeenCalled()
  })

  it('ignores open PRs from forks, other bases, and non-release branches', async () => {
    api.openPRs = [
      { number: 1, body: null, head: { ref: 'release/v1.2.4', repo: { full_name: 'fork/repo' } }, base: { ref: 'main' }, updated_at: '2024-01-02T00:00:00Z' },
      { number: 2, body: null, head: { ref: 'release/v1.2.5', repo: { full_name: 'owner/repo' } }, base: { ref: '4.x' }, updated_at: '2024-01-02T00:00:00Z' },
      { number: 3, body: null, head: { ref: 'feat/thing', repo: { full_name: 'owner/repo' } }, base: { ref: 'main' }, updated_at: '2024-01-02T00:00:00Z' },
      { number: 4, body: null, head: { ref: 'release/v1.3.0', repo: { full_name: 'owner/repo' } }, base: { ref: 'main' }, updated_at: '2024-01-02T00:00:00Z' },
    ]
    await main()
    expect(calls.filter(c => c.method === 'PATCH' && /\/pulls\/[123]$/.test(c.path))).toEqual([])
  })

  it('updates the existing PR for the target version', async () => {
    api.openPRs = [{
      number: 9,
      body: '> keep me\n\n## 👉 Changelog\n\nold',
      head: { ref: 'release/v1.3.0', repo: { full_name: 'owner/repo' } },
      base: { ref: 'main' },
      updated_at: '2024-01-02T00:00:00Z',
    }]
    api.branches.set('release/v1.3.0', 'bumped-sha')
    await main()
    const patch = calls.findLast(c => c.method === 'PATCH' && c.path === '/repos/owner/repo/pulls/9')!
    expect(patch.body).toMatchObject({ title: 'v1.3.0' })
    expect(prBody()).toContain('> keep me')
    expect(calls.some(c => c.path.endsWith('/git/trees'))).toBe(false)
  })

  it('recovers a release branch that sits at base with no bump', async () => {
    api.branches.set('release/v1.3.0', 'base-sha')
    await main()
    expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/git/trees'))).toBe(true)
  })

  it('requires a token to create the release branch', async () => {
    delete process.env.GITHUB_TOKEN
    await expect(main()).rejects.toThrow('GITHUB_TOKEN is required to create the release branch')
  })

  it('requires a token to create or update the PR', async () => {
    delete process.env.GITHUB_TOKEN
    api.branches.set('release/v1.3.0', 'bumped-sha')
    await expect(main()).rejects.toThrow('GITHUB_TOKEN is required to create or update the PR')
  })

  it('makes no writes in dry-run mode', async () => {
    process.env.DRY_RUN = '1'
    await main()
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('bumps every workspace in a monorepo, plus a matching root', async () => {
    writePackage('.', { name: 'monorepo', version: '1.2.3' })
    writePackage('packages/a', { name: 'a', version: '1.2.3' })
    writePackage('packages/b', { name: 'b', version: '1.2.3' })
    process.env.PACKAGES = 'packages/*'
    await main()
    expect(committedFiles().map(f => f.path)).toEqual(['packages/a/package.json', 'packages/b/package.json', 'package.json'])
    expect(blobContents().map(c => JSON.parse(c).version)).toEqual(['1.3.0', '1.3.0', '1.3.0'])
  })

  it('cuts a prerelease when PRERELEASE is set', async () => {
    process.env.PRERELEASE = 'beta'
    await main()
    const created = calls.find(c => c.method === 'POST' && c.path.endsWith('/pulls'))!
    expect(created.body).toMatchObject({ title: 'v1.3.0-beta.0' })
  })

  it('propagates an unexpected branch-lookup failure', async () => {
    api.fail.set('GET /repos/owner/repo/branches/release%2Fv1.3.0', 500)
    await expect(main()).rejects.toThrow(/-> 500/)
  })

  it('treats a failing tag listing as no tags at all', async () => {
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'for-each-ref') throw new Error('not a git repository')
      if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? git.branch : HEAD_SHA
      if (args[0] === 'log') return record(FEAT)
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    await main()
    expect(prBody()).not.toContain('compare changes')
  })

  it('ignores unparseable log records and keeps non-conventional subjects out of the changelog', async () => {
    git.commits = [
      FEAT,
      { hash: '', short: '', name: '', email: '', subject: '' },
      { ...FEAT, hash: 'e'.repeat(40), short: 'eeeeeee', name: '', email: '', subject: 'not a conventional commit' },
      { ...FEAT, hash: 'f'.repeat(40), short: 'fffffff', name: '', email: '', subject: 'fix: from an unnamed author' },
    ]
    await main()
    expect(prBody()).toContain('- add a thing (#7)')
    expect(prBody()).not.toContain('not a conventional commit')
  })

  it('collects issue references from the commit body', async () => {
    git.commits = [{ ...FEAT, subject: 'fix: repair the thing', body: 'Fixes #12\nBREAKING CHANGE: it moved' }]
    await main()
    expect(prBody()).toContain('- ⚠️  repair the thing (#12)')
    const created = calls.find(c => c.method === 'POST' && c.path.endsWith('/pulls'))!
    expect(created.body).toMatchObject({ title: 'v2.0.0' })
  })

  it('carries the preamble of the most recently updated superseded PR', async () => {
    api.openPRs = [
      { number: 3, body: '> older intro\n\n## 👉 Changelog', head: { ref: 'release/v1.2.4', repo: { full_name: 'owner/repo' } }, base: { ref: 'main' }, updated_at: '2024-01-02T00:00:00Z' },
      { number: 4, body: '> newer intro\n\n## 👉 Changelog', head: { ref: 'release/v1.2.5', repo: { full_name: 'owner/repo' } }, base: { ref: 'main' }, updated_at: '2024-03-02T00:00:00Z' },
    ]
    await main()
    expect(prBody()).toContain('> newer intro')
  })

  it('propagates a transient failure while resolving the release branch parent', async () => {
    api.branches.set('release/v1.3.0', 'base-sha')
    api.failNth.set('GET /repos/owner/repo/branches/release%2Fv1.3.0', { nth: 2, status: 500 })
    await expect(main()).rejects.toThrow(/-> 500/)
  })

  it('creates the release branch when it does not exist yet', async () => {
    await main()
    const createRef = calls.find(c => c.method === 'POST' && c.path.endsWith('/git/refs'))!
    expect(createRef.body).toMatchObject({ ref: 'refs/heads/release/v1.3.0', sha: 'base-sha' })
  })
})

describe('contributors', () => {
  const second: FakeCommit = { hash: 'b'.repeat(40), short: 'bbbbbbb', name: 'Bo', email: 'bo@example.com', subject: 'fix: another' }

  it('skips renovate, deduplicates authors, and marks returning contributors', async () => {
    git.commits = [
      FEAT,
      { ...FEAT, hash: 'c'.repeat(40), short: 'ccccccc', subject: 'fix: same author again' },
      { ...second, name: 'renovate[bot]', email: 'bot@example.com' },
      second,
    ]
    api.logins = new Map([['aaaaaaa', 'ada'], ['bbbbbbb', 'bo']])
    api.priorCommits = new Map([['ada', [{}]]])
    await main()
    expect(prBody()).toContain('### 🎉 New Contributors')
    expect(prBody()).toMatch(/### 🎉 New Contributors\n\n- Bo \(@bo\)/)
    expect(prBody()).toContain('- Ada (@ada)')
  })

  it('skips commits whose author lookup fails or has no linked account', async () => {
    git.commits = [FEAT, second]
    api.logins = new Map([['aaaaaaa', null]])
    await main()
    expect(prBody()).toContain('_no contributors yet_')
  })

  it('deduplicates two emails mapping to the same account', async () => {
    git.commits = [FEAT, { ...second, short: 'bbbbbbb' }]
    api.logins = new Map([['aaaaaaa', 'ada'], ['bbbbbbb', 'ada']])
    api.priorCommits = new Map([['ada', [{}]]])
    await main()
    expect(prBody()!.match(/- Ada \(@ada\)/g)).toHaveLength(1)
  })

  it('treats a failed prior-commit lookup as a returning contributor', async () => {
    api.fail.set('GET /repos/owner/repo/commits', 500)
    await main()
    expect(prBody()).not.toContain('New Contributors')
  })

  it('treats everyone as first-time when there is no previous tag', async () => {
    git.tags = []
    await main()
    expect(prBody()).toContain('### 🎉 New Contributors')
  })
})

describe('independent main', () => {
  beforeEach(() => {
    process.env.MODE = 'independent'
    process.env.PACKAGES = 'packages/*'
    writePackage('.', { name: 'monorepo', version: '0.0.0', private: true })
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/b', { name: 'b', version: '2.0.0', dependencies: { a: 'workspace:*' } })
    git.tags = ['a@1.0.0', 'b@2.0.0']
    git.commits = [{ ...FEAT, subject: 'feat(a): add a thing (#7)' }]
  })

  it('syncs the pending branch and opens a PR', async () => {
    await main()
    expect(committedFiles().map(f => f.path)).toEqual(['packages/a/package.json', 'packages/b/package.json'])
    expect(blobContents().map(c => JSON.parse(c).version)).toEqual(['1.1.0', '2.0.1'])
    const created = calls.find(c => c.method === 'POST' && c.path.endsWith('/pulls'))!
    expect(created.body).toMatchObject({ title: 'chore: release 2 packages', head: 'release/main-pending' })
    expect(prBody()).toContain('### a (1.0.0 → 1.1.0)')
    expect(prBody()).toContain('_Released because `a` was bumped; no direct changes._')
  })

  it('does nothing when no package has unreleased commits', async () => {
    git.commits = [{ ...FEAT, subject: 'feat(unknown): elsewhere' }]
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main()
    expect(log).toHaveBeenCalledWith('Independent release plan: no packages to release.')
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('lists unrouted commits in the log and the body', async () => {
    git.commits = [{ ...FEAT, subject: 'feat(a): routed' }, { ...FEAT, hash: 'd'.repeat(40), short: 'ddddddd', subject: 'fix: unscoped' }]
    git.revList = [FEAT.hash, 'd'.repeat(40)]
    await main()
    expect(prBody()).toContain('### 📝 Other commits')
    expect(prBody()).toContain('fix: unscoped')
  })

  it('routes scope overrides from the SCOPES input', async () => {
    process.env.SCOPES = 'a: alias'
    git.commits = [{ ...FEAT, subject: 'feat(alias): via override' }]
    await main()
    expect(prBody()).toContain('### a (1.0.0 → 1.1.0)')
  })

  it('uses the full history when a package has no boundary tag', async () => {
    git.tags = []
    await main()
    expect(prBody()).toContain('### a (1.0.0 → 1.1.0)')
    expect(execFileSync.mock.calls.some(([, args]) => args[0] === 'log' && args[1] === 'HEAD')).toBe(true)
  })

  it('leaves the branch alone when it already carries the plan', async () => {
    api.branches.set('release/main-pending', 'pending-sha')
    api.compares.set('main...release/main-pending', {
      files: [{ filename: 'packages/a/package.json' }, { filename: 'packages/b/package.json' }],
      merge_base_commit: { sha: 'base-sha' },
      behind_by: 0,
    })
    api.contents.set('release/main-pending:packages/a/package.json', JSON.stringify({ name: 'a', version: '1.1.0' }, null, 2) + '\n')
    api.contents.set('release/main-pending:packages/b/package.json', JSON.stringify({ name: 'b', version: '2.0.1', dependencies: { a: 'workspace:*' } }, null, 2) + '\n')
    await main()
    expect(calls.some(c => c.path.endsWith('/git/trees'))).toBe(false)
  })

  it('force-updates an existing branch that drifted from the plan', async () => {
    api.branches.set('release/main-pending', 'pending-sha')
    api.compares.set('main...release/main-pending', {
      files: [{ filename: 'packages/a/package.json' }],
      merge_base_commit: { sha: 'merge-base' },
      behind_by: 2,
    })
    api.compares.set('merge-base...main', { files: [{ filename: 'packages/b/package.json' }], merge_base_commit: { sha: 'merge-base' }, behind_by: 0 })
    await main()
    const patch = calls.findLast(c => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/release/main-pending'))!
    expect(patch.body).toMatchObject({ sha: 'commit-sha', force: true })
  })

  it('propagates an unexpected compare failure', async () => {
    api.branches.set('release/main-pending', 'pending-sha')
    api.fail.set('GET /repos/owner/repo/compare/main...release%2Fmain-pending', 500)
    await expect(main()).rejects.toThrow(/-> 500/)
  })

  it('treats a non-base64 contents response as a missing file', async () => {
    api.branches.set('release/main-pending', 'pending-sha')
    api.compares.set('main...release/main-pending', {
      files: [{ filename: 'packages/a/package.json' }, { filename: 'packages/b/package.json' }],
      merge_base_commit: { sha: 'base-sha' },
      behind_by: 0,
    })
    api.rawContents.set('release/main-pending:packages/a/package.json', { encoding: 'none' })
    api.rawContents.set('release/main-pending:packages/b/package.json', { encoding: 'base64' })
    await main()
    expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/git/trees'))).toBe(true)
  })

  it('rebuilds when the compare response carries no file list', async () => {
    api.branches.set('release/main-pending', 'pending-sha')
    api.compares.set('main...release/main-pending', { merge_base_commit: { sha: 'merge-base' }, behind_by: 1 })
    api.compares.set('merge-base...main', { merge_base_commit: { sha: 'merge-base' }, behind_by: 0 })
    await main()
    expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/git/trees'))).toBe(true)
  })

  it('ignores base changes to files outside the plan', async () => {
    api.branches.set('release/main-pending', 'pending-sha')
    api.compares.set('main...release/main-pending', {
      files: [{ filename: 'packages/a/package.json' }, { filename: 'packages/b/package.json' }],
      merge_base_commit: { sha: 'merge-base' },
      behind_by: 4,
    })
    api.compares.set('merge-base...main', { files: [{ filename: 'README.md' }], merge_base_commit: { sha: 'merge-base' }, behind_by: 0 })
    api.contents.set('release/main-pending:packages/a/package.json', JSON.stringify({ name: 'a', version: '1.1.0' }, null, 2) + '\n')
    api.contents.set('release/main-pending:packages/b/package.json', JSON.stringify({ name: 'b', version: '2.0.1', dependencies: { a: 'workspace:*' } }, null, 2) + '\n')
    await main()
    expect(calls.some(c => c.path.endsWith('/git/trees'))).toBe(false)
  })

  it('takes the oldest per-package tag as the union range start', async () => {
    git.tags = ['b@2.0.0', 'a@1.0.0']
    await main()
    expect(execFileSync.mock.calls.some(([, args]) => args[0] === 'log' && args[1] === 'refs/tags/a@1.0.0..HEAD')).toBe(true)
  })

  it('reuses the cached commit list per boundary tag', async () => {
    git.commits = [
      { ...FEAT, subject: 'feat(a): one' },
      { ...FEAT, hash: 'f'.repeat(40), short: 'fffffff', subject: 'fix(a): two' },
    ]
    git.revList = [FEAT.hash, 'f'.repeat(40)]
    await main()
    const revLists = execFileSync.mock.calls.filter(([, args]) => args[0] === 'rev-list' && args[1] === 'refs/tags/a@1.0.0..HEAD')
    expect(revLists).toHaveLength(1)
    expect(prBody()).toContain('### a (1.0.0 → 1.1.0)')
  })

  it('propagates an unexpected file-contents failure', async () => {
    api.branches.set('release/main-pending', 'pending-sha')
    api.compares.set('main...release/main-pending', {
      files: [{ filename: 'packages/a/package.json' }, { filename: 'packages/b/package.json' }],
      merge_base_commit: { sha: 'base-sha' },
      behind_by: 0,
    })
    api.fail.set('GET /repos/owner/repo/contents/packages/a/package.json', 500)
    await expect(main()).rejects.toThrow(/-> 500/)
  })

  it('closes a stale lockstep PR before syncing', async () => {
    api.openPRs = [{
      number: 5,
      body: '> lockstep intro',
      head: { ref: 'release/v1.2.4', repo: { full_name: 'owner/repo' } },
      base: { ref: 'main' },
      updated_at: '2024-01-02T00:00:00Z',
    }]
    await main()
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'PATCH', path: '/repos/owner/repo/pulls/5', body: { state: 'closed' } }),
    ]))
    expect(prBody()).toContain('> lockstep intro')
  })

  it('updates an existing pending PR and keeps its preamble', async () => {
    api.openPRs = [{
      number: 8,
      body: '> pending intro\n\n## 👉 Changelog\n\nold',
      head: { ref: 'release/main-pending', repo: { full_name: 'owner/repo' } },
      base: { ref: 'main' },
      updated_at: '2024-01-02T00:00:00Z',
    }]
    await main()
    const patch = calls.findLast(c => c.method === 'PATCH' && c.path === '/repos/owner/repo/pulls/8')!
    expect((patch.body as { body: string }).body).toContain('> pending intro')
  })

  it('names a single-package release in the title', async () => {
    writePackage('packages/b', { name: 'b', version: '2.0.0' })
    await main()
    const created = calls.find(c => c.method === 'POST' && c.path.endsWith('/pulls'))!
    expect(created.body).toMatchObject({ title: 'chore: release 1 package' })
  })

  it('makes no writes in dry-run mode', async () => {
    process.env.DRY_RUN = '1'
    await main()
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('requires a token to create the release branch', async () => {
    delete process.env.GITHUB_TOKEN
    await expect(main()).rejects.toThrow('GITHUB_TOKEN is required to create the release branch')
  })

  it('cuts prereleases for every planned package', async () => {
    process.env.PRERELEASE = 'rc'
    await main()
    expect(blobContents().map(c => JSON.parse(c).version)).toEqual(['1.1.0-rc.0', '2.0.1-rc.0'])
  })
})
