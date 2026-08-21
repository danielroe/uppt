import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMain } from '../scripts/_cli.ts'

const entry = `file://${process.argv[1]}`

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runMain', () => {
  it('does nothing when the module is not the entrypoint', () => {
    const main = vi.fn()
    runMain('file:///somewhere/else.ts', main)
    expect(main).not.toHaveBeenCalled()
  })

  it('runs main when the module is the entrypoint', () => {
    const main = vi.fn()
    runMain(entry, main)
    expect(main).toHaveBeenCalled()
  })

  it('exits non-zero when main throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    runMain(entry, () => {
      throw new Error('boom')
    })
    expect(error).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits non-zero when an async main rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    runMain(entry, async () => {
      throw new Error('boom')
    })
    await new Promise(r => setTimeout(r, 0))
    expect(error).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('leaves a resolving async main alone', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    runMain(entry, async () => 'ok')
    await new Promise(r => setTimeout(r, 0))
    expect(exit).not.toHaveBeenCalled()
  })
})
