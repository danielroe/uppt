import { Buffer } from 'node:buffer'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../scripts/pin-readme.ts'

const SHA = 'a'.repeat(40)

interface StubResponse { status?: number, body?: unknown }

let env: NodeJS.ProcessEnv
let fetchMock: ReturnType<typeof vi.fn>

function respond (queue: StubResponse[]) {
  fetchMock.mockImplementation(() => {
    const next = queue.shift() ?? { status: 200, body: {} }
    const text = next.body === undefined ? '' : JSON.stringify(next.body)
    const status = next.status ?? 200
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) })
  })
}

function contents (readme: string) {
  return { sha: 'filesha', encoding: 'base64', content: Buffer.from(readme, 'utf8').toString('base64') }
}

const README = 'uses: danielroe/uppt/pr@old # v0.0.1\nuses: danielroe/uppt/publish@old\n'

beforeEach(() => {
  env = { ...process.env }
  process.env.GITHUB_TOKEN = 'tok'
  process.env.GITHUB_REPOSITORY = 'owner/repo'
  process.env.GITHUB_REF_NAME = 'v1.2.3'
  process.env.GITHUB_SHA = SHA
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  process.env = env
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pin-readme', () => {
  it('requires a token', async () => {
    delete process.env.GITHUB_TOKEN
    await expect(main()).rejects.toThrow('GITHUB_TOKEN is required')
  })

  it('rejects an invalid repository', async () => {
    process.env.GITHUB_REPOSITORY = 'owner/repo/extra'
    await expect(main()).rejects.toThrow(/GITHUB_REPOSITORY invalid/)
  })

  it('rejects a non-semver tag', async () => {
    process.env.GITHUB_REF_NAME = 'latest'
    await expect(main()).rejects.toThrow(/not a semver tag/)
  })

  it('rejects a missing tag', async () => {
    delete process.env.GITHUB_REF_NAME
    await expect(main()).rejects.toThrow(/not a semver tag: $/)
  })

  it('rejects an invalid sha', async () => {
    process.env.GITHUB_SHA = 'abc'
    await expect(main()).rejects.toThrow(/GITHUB_SHA invalid/)
  })

  it('rejects a missing sha', async () => {
    delete process.env.GITHUB_SHA
    await expect(main()).rejects.toThrow(/GITHUB_SHA invalid: $/)
  })

  it('throws when the default branch cannot be resolved', async () => {
    respond([{ status: 200 }])
    await expect(main()).rejects.toThrow('Could not resolve default branch')
  })

  it('surfaces an API failure', async () => {
    respond([{ status: 500, body: { message: 'boom' } }])
    await expect(main()).rejects.toThrow(/GET \/repos\/owner\/repo failed: 500/)
  })

  it('rejects an unexpected README encoding', async () => {
    respond([
      { body: { default_branch: 'main' } },
      { body: { sha: 'filesha', encoding: 'utf-8', content: README } },
    ])
    await expect(main()).rejects.toThrow(/Unexpected README encoding: utf-8/)
  })

  it('pins every uses line to the release sha', async () => {
    respond([
      { body: { default_branch: 'main' } },
      { body: contents(README) },
      { status: 200, body: { commit: { sha: 'c', html_url: 'https://example.com/c' } } },
    ])
    await main()
    const [, init] = fetchMock.mock.calls.at(-1)!
    const sent = JSON.parse(init.body as string) as { content: string, message: string, sha: string, branch: string }
    expect(Buffer.from(sent.content, 'base64').toString('utf8')).toBe(
      `uses: danielroe/uppt/pr@${SHA} # v1.2.3\nuses: danielroe/uppt/publish@${SHA} # v1.2.3\n`,
    )
    expect(sent).toMatchObject({ message: 'chore: pin README example to v1.2.3', sha: 'filesha', branch: 'main' })
  })

  it('does nothing when the README is already pinned', async () => {
    respond([
      { body: { default_branch: 'main' } },
      { body: contents(`uses: danielroe/uppt/pr@${SHA} # v1.2.3\n`) },
    ])
    await main()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries when the branch advances under it', async () => {
    respond([
      { body: { default_branch: 'main' } },
      { body: contents(README) },
      { status: 409, body: { message: 'conflict' } },
      { body: contents(README) },
      { status: 200, body: { commit: { sha: 'c', html_url: 'https://example.com/c' } } },
    ])
    await main()
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('gives up after five failed attempts', async () => {
    fetchMock.mockImplementation((url: string, init: { method: string }) => {
      const reply = (status: number, body: unknown) => Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
      })
      if (init.method === 'PUT') return reply(422, { message: 'does not match' })
      if (url.includes('/contents/')) return reply(200, contents(README))
      return reply(200, { default_branch: 'main' })
    })
    await expect(main()).rejects.toThrow('Exhausted retries trying to update README.md')
  })
})
