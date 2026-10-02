import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../scripts/resolve-pr-target.ts'

describe('main', () => {
  let env: NodeJS.ProcessEnv
  let output: string
  let pulls: unknown[]
  let status: number

  beforeEach(() => {
    env = { ...process.env }
    output = resolve(mkdtempSync(resolve(tmpdir(), 'uppt-target-')), 'out')
    writeFileSync(output, '')
    Object.assign(process.env, {
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_TOKEN: 'tok',
      BASE_BRANCH: 'main',
      PRERELEASE: 'beta',
    })
    pulls = []
    status = 200
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: status === 200,
      status,
      statusText: '',
      text: () => Promise.resolve('nope'),
      json: () => Promise.resolve(pulls),
    })))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = env
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('passes the inputs through for a push to the base branch', async () => {
    process.env.GITHUB_REF = 'refs/heads/main'
    await main()
    expect(readFileSync(output, 'utf8')).toBe('skip=false\nbase=main\nprerelease=beta\n')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('targets the base and track of the open PR for a pushed release branch', async () => {
    process.env.GITHUB_REF = 'refs/heads/release/v5.0.0-rc.1'
    pulls = [{ base: { ref: '4.x' } }]
    await main()
    expect(readFileSync(output, 'utf8')).toBe('skip=false\nbase=4.x\nprerelease=rc\n')
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls?state=open&head=owner%3Arelease%2Fv5.0.0-rc.1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    )
  })

  it('skips a pushed release branch with no open PR', async () => {
    process.env.GITHUB_REF = 'refs/heads/release/v1.3.0'
    delete process.env.GITHUB_TOKEN
    await main()
    expect(readFileSync(output, 'utf8')).toBe('skip=true\nbase=\nprerelease=\n')
  })

  it('skips a pushed release branch with an invalid prerelease identifier', async () => {
    process.env.GITHUB_REF = 'refs/heads/release/v1.3.0-Beta.1'
    await main()
    expect(readFileSync(output, 'utf8')).toBe('skip=true\nbase=\nprerelease=\n')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws when the PR lookup fails', async () => {
    process.env.GITHUB_REF = 'refs/heads/release/v1.3.0'
    status = 500
    await expect(main()).rejects.toThrow(/-> 500/)
  })

  it('writes to stdout outside Actions', async () => {
    delete process.env.GITHUB_OUTPUT
    delete process.env.GITHUB_REF
    delete process.env.BASE_BRANCH
    delete process.env.PRERELEASE
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await main()
    expect(write).toHaveBeenCalledWith('skip=false\nbase=\nprerelease=\n')
  })
})
