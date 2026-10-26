import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))

const { addDistTags, parseDistTagEntries, parseDistTags, tarballManifest } = await import('../scripts/_dist-tags.ts')

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  execFileSync.mockReset()
  vi.restoreAllMocks()
})

describe('parseDistTags', () => {
  it('splits on whitespace and commas, dropping duplicates', () => {
    expect(parseDistTags(' latest, 4x\n4x  next ', 'npm-tag')).toEqual(['latest', '4x', 'next'])
  })

  it('returns nothing for an empty value', () => {
    expect(parseDistTags(undefined, 'npm-tag')).toEqual([])
    expect(parseDistTags('  ', 'npm-tag')).toEqual([])
  })

  it.each(['-bad', 'a/b', '1.2.3'])('rejects %s', (tag) => {
    expect(() => parseDistTags(`latest ${tag}`, 'npm-tag')).toThrow(`npm-tag is not a valid dist-tag: ${JSON.stringify(tag)}`)
  })
})

describe('parseDistTagEntries', () => {
  it('parses entries', () => {
    const entries = [{ name: '@nuxt/kit', version: '4.1.0', tags: ['4x'] }]
    expect(parseDistTagEntries(JSON.stringify(entries))).toEqual(entries)
  })

  it('treats an empty value as no entries', () => {
    expect(parseDistTagEntries(undefined)).toEqual([])
    expect(parseDistTagEntries(' ')).toEqual([])
  })

  it('rejects malformed JSON', () => {
    expect(() => parseDistTagEntries('{')).toThrow(/DIST_TAGS is not valid JSON/)
  })

  it('rejects a non-array', () => {
    expect(() => parseDistTagEntries('{}')).toThrow('DIST_TAGS must be a JSON array')
  })

  it.each([
    null,
    { name: 1, version: '1.0.0', tags: ['4x'] },
    { name: '-a', version: '1.0.0', tags: ['4x'] },
    { name: 'a', version: 1, tags: ['4x'] },
    { name: 'a', version: 'next', tags: ['4x'] },
    { name: 'a', version: '1.0.0', tags: '4x' },
    { name: 'a', version: '1.0.0', tags: [] },
    { name: 'a', version: '1.0.0', tags: [1] },
  ])('rejects %j', (entry) => {
    expect(() => parseDistTagEntries(JSON.stringify([entry]))).toThrow(/DIST_TAGS contains an invalid entry/)
  })

  it('rejects an invalid tag', () => {
    expect(() => parseDistTagEntries(JSON.stringify([{ name: 'a', version: '1.0.0', tags: ['a/b'] }]))).toThrow('DIST_TAGS is not a valid dist-tag: "a/b"')
  })
})

describe('tarballManifest', () => {
  it('reads the name and version from the tarball', () => {
    execFileSync.mockReturnValue('{"name":"@nuxt/kit","version":"4.1.0","private":false}')
    expect(tarballManifest('/tmp/nuxt-kit-4.1.0.tgz')).toEqual({ name: '@nuxt/kit', version: '4.1.0' })
    expect(execFileSync).toHaveBeenCalledWith('tar', ['-xzOf', '/tmp/nuxt-kit-4.1.0.tgz', 'package/package.json'], { encoding: 'utf8' })
  })

  it.each([
    {},
    { name: '-a', version: '1.0.0' },
    { name: 'a', version: 'latest' },
    { name: 'a' },
  ])('rejects %j', (manifest) => {
    execFileSync.mockReturnValue(JSON.stringify(manifest))
    expect(() => tarballManifest('/tmp/a.tgz')).toThrow(/has an invalid name or version/)
  })
})

describe('addDistTags', () => {
  function stubTags (stdout: string) {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => args[1] === 'ls' ? stdout : '')
  }

  function added () {
    return execFileSync.mock.calls.filter(([, args]) => args[1] === 'add').map(([, args]) => args.slice(2))
  }

  it('adds a tag the package does not have yet', () => {
    stubTags('latest: 4.0.0\n')
    addDistTags({ name: 'a', version: '4.1.0', tags: ['4x'] })
    expect(added()).toEqual([['a@4.1.0', '4x']])
  })

  it('moves a tag forward', () => {
    stubTags('latest: 4.0.0\n4x: 4.0.0\n')
    addDistTags({ name: 'a', version: '4.1.0', tags: ['latest', '4x'] })
    expect(added()).toEqual([['a@4.1.0', 'latest'], ['a@4.1.0', '4x']])
  })

  it('leaves a tag pointing at the same or a newer version', () => {
    stubTags('latest: 5.0.0\n4x: 4.1.0\nbeta: 4.2.0-beta.1\n')
    addDistTags({ name: 'a', version: '4.1.0', tags: ['latest', '4x', 'beta'] })
    expect(added()).toEqual([])
    expect(console.log).toHaveBeenCalledWith('a@latest is already 5.0.0; leaving it in place of 4.1.0.')
  })

  it('moves a tag pointing at something other than a version', () => {
    stubTags('weird: not-a-version\nnoise\n')
    addDistTags({ name: 'a', version: '4.1.0', tags: ['weird'] })
    expect(added()).toEqual([['a@4.1.0', 'weird']])
  })
})
