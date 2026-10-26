import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
const spawnSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync, spawnSync }))

const { main } = await import('../scripts/dist-tag.ts')

let env: NodeJS.ProcessEnv
let live: Map<string, number>
const sleep = vi.fn(async () => {})

function added () {
  return execFileSync.mock.calls.filter(([, args]) => args[1] === 'add').map(([, args]) => args.slice(2))
}

beforeEach(() => {
  env = { ...process.env }
  delete process.env.TIMEOUT_MINUTES
  process.env.DIST_TAGS = JSON.stringify([
    { name: 'a', version: '4.1.0', tags: ['4x'] },
    { name: '@scope/b', version: '4.1.0', tags: ['4x'] },
  ])
  live = new Map()
  spawnSync.mockImplementation((_cmd: string, args: string[]) => {
    const [spec] = args.slice(1)
    const remaining = live.get(spec!)
    if (remaining === undefined) return { status: 1, stdout: '' }
    if (remaining > 0) {
      live.set(spec!, remaining - 1)
      return { status: 0, stdout: '' }
    }
    return { status: 0, stdout: `${spec!.slice(spec!.lastIndexOf('@') + 1)}\n` }
  })
  execFileSync.mockImplementation((_cmd: string, args: string[]) => args[1] === 'ls' ? 'latest: 4.1.0\n4x: 4.0.0\n' : '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  process.env = env
  execFileSync.mockReset()
  spawnSync.mockReset()
  sleep.mockClear()
  vi.restoreAllMocks()
})

describe('dist-tag', () => {
  it('does nothing without entries', async () => {
    process.env.DIST_TAGS = '[]'
    await main(sleep)
    expect(spawnSync).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('No dist-tags to apply.')
  })

  it('tags versions that are already live', async () => {
    live.set('a@4.1.0', 0).set('@scope/b@4.1.0', 0)
    await main(sleep)
    expect(added()).toEqual([['a@4.1.0', '4x'], ['@scope/b@4.1.0', '4x']])
    expect(sleep).not.toHaveBeenCalled()
    expect(spawnSync).toHaveBeenCalledWith('npm', ['view', 'a@4.1.0', 'version', '--prefer-online'], { encoding: 'utf8' })
  })

  it('waits for each version to be approved', async () => {
    live.set('a@4.1.0', 0).set('@scope/b@4.1.0', 2)
    await main(sleep)
    expect(added()).toEqual([['a@4.1.0', '4x'], ['@scope/b@4.1.0', '4x']])
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(30_000)
    expect(console.log).toHaveBeenCalledWith('Waiting for @scope/b@4.1.0 to be approved on npmjs.com...')
  })

  it('times out when a version is never approved', async () => {
    process.env.TIMEOUT_MINUTES = '1'
    live.set('a@4.1.0', 0)
    await expect(main(sleep)).rejects.toThrow('Timed out after 1 minute(s) waiting for @scope/b@4.1.0 to go live. Approve the staged version(s) on npmjs.com, then re-run this job.')
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(added()).toEqual([['a@4.1.0', '4x']])
  })

  it('checks once with a zero timeout', async () => {
    process.env.TIMEOUT_MINUTES = '0'
    await expect(main(sleep)).rejects.toThrow(/Timed out after 0 minute\(s\) waiting for a@4\.1\.0, @scope\/b@4\.1\.0/)
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each(['-1', 'soon'])('rejects TIMEOUT_MINUTES=%s', async (value) => {
    process.env.TIMEOUT_MINUTES = value
    await expect(main(sleep)).rejects.toThrow(`TIMEOUT_MINUTES must be a non-negative number, got ${JSON.stringify(value)}`)
  })
})
