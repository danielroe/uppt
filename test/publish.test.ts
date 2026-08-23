import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))

const { main, distTag, versionFromTarballName } = await import('../scripts/publish.ts')

function fixture (files: string[]): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'uppt-publish-'))
  for (const file of files) writeFileSync(resolve(dir, file), 'x')
  return dir
}

function npmArgs () {
  return execFileSync.mock.calls.map(([, args]) => args as string[])
}

let env: NodeJS.ProcessEnv

beforeEach(() => {
  env = { ...process.env }
  for (const key of ['NPM_ACCESS', 'NPM_TAG', 'TARBALL_DIR', 'TARBALL_FILES', 'RELEASES']) delete process.env[key]
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  process.env = env
  execFileSync.mockReset()
  vi.restoreAllMocks()
})

describe('publish', () => {
  it('requires TARBALL_DIR', () => {
    expect(() => main()).toThrow('TARBALL_DIR is required')
  })

  it('rejects a missing TARBALL_DIR', () => {
    process.env.TARBALL_DIR = resolve(tmpdir(), 'uppt-does-not-exist')
    expect(() => main()).toThrow(/TARBALL_DIR does not exist/)
  })

  it('stages every tarball found in the directory, sorted', () => {
    process.env.TARBALL_DIR = fixture(['b-1.0.0.tgz', 'a-1.0.0.tgz', 'notes.txt'])
    main()
    expect(npmArgs()).toEqual([
      ['stage', 'publish', resolve(process.env.TARBALL_DIR!, 'a-1.0.0.tgz'), '--provenance', '--ignore-scripts', '--access=public', '--tag=latest'],
      ['stage', 'publish', resolve(process.env.TARBALL_DIR!, 'b-1.0.0.tgz'), '--provenance', '--ignore-scripts', '--access=public', '--tag=latest'],
    ])
  })

  it('honours NPM_ACCESS=restricted', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.NPM_ACCESS = 'restricted'
    main()
    expect(npmArgs()[0]).toContain('--access=restricted')
  })

  it('falls back to public for an unknown NPM_ACCESS', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.NPM_ACCESS = 'nonsense'
    main()
    expect(npmArgs()[0]).toContain('--access=public')
  })

  it('throws when the directory holds no tarballs', () => {
    process.env.TARBALL_DIR = fixture(['notes.txt'])
    expect(() => main()).toThrow(/No \*\.tgz found in/)
  })

  it('publishes TARBALL_FILES in the given order', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz', 'b-1.0.0.tgz'])
    process.env.TARBALL_FILES = '["b-1.0.0.tgz","a-1.0.0.tgz"]'
    main()
    expect(npmArgs().map(args => args[2])).toEqual([
      resolve(process.env.TARBALL_DIR!, 'b-1.0.0.tgz'),
      resolve(process.env.TARBALL_DIR!, 'a-1.0.0.tgz'),
    ])
  })

  it('rejects malformed TARBALL_FILES', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.TARBALL_FILES = '{'
    expect(() => main()).toThrow(/TARBALL_FILES is not valid JSON/)
  })

  it('rejects a non-array TARBALL_FILES', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.TARBALL_FILES = '{"a":1}'
    expect(() => main()).toThrow('TARBALL_FILES must be a JSON array of filenames')
  })

  it('rejects a TARBALL_FILES entry that is not a tarball', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.TARBALL_FILES = '["a-1.0.0.zip"]'
    expect(() => main()).toThrow(/non-tarball entry/)
  })

  it('rejects an empty TARBALL_FILES array', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.TARBALL_FILES = '[]'
    expect(() => main()).toThrow('TARBALL_FILES was provided but is empty')
  })

  it('derives tarball names from RELEASES when TARBALL_FILES is absent', () => {
    process.env.TARBALL_DIR = fixture(['nuxt-kit-5.0.0.tgz', 'stray-9.0.0.tgz'])
    process.env.RELEASES = JSON.stringify([{ name: '@nuxt/kit', version: '5.0.0', dir: 'packages/kit' }])
    main()
    expect(npmArgs().map(args => args[2])).toEqual([
      resolve(process.env.TARBALL_DIR!, 'nuxt-kit-5.0.0.tgz'),
    ])
  })

  it('throws when a named tarball is missing', () => {
    process.env.TARBALL_DIR = fixture([])
    process.env.TARBALL_FILES = '["a-1.0.0.tgz"]'
    expect(() => main()).toThrow(/Tarball 'a-1\.0\.0\.tgz' is not present/)
  })

  it('stages prereleases under the prerelease identifier', () => {
    process.env.TARBALL_DIR = fixture(['a-5.0.0-beta.0.tgz'])
    main()
    expect(npmArgs()[0]).toContain('--tag=beta')
  })

  it('refuses to guess a tag for a tarball with no version in its name', () => {
    process.env.TARBALL_DIR = fixture(['bundle.tgz'])
    expect(() => main()).toThrow(/Could not parse a version out of tarball 'bundle\.tgz'/)
  })

  it('accepts an unversioned tarball when NPM_TAG is set', () => {
    process.env.TARBALL_DIR = fixture(['bundle.tgz'])
    process.env.NPM_TAG = 'next'
    main()
    expect(npmArgs()[0]).toContain('--tag=next')
  })

  it('derives a tag per tarball in independent mode', () => {
    process.env.TARBALL_DIR = fixture(['nuxt-kit-5.0.0-rc.1.tgz', 'nuxt-schema-4.1.0.tgz'])
    process.env.RELEASES = JSON.stringify([
      { name: '@nuxt/kit', version: '5.0.0-rc.1', dir: 'packages/kit' },
      { name: '@nuxt/schema', version: '4.1.0', dir: 'packages/schema' },
    ])
    main()
    expect(npmArgs().map(args => args.at(-1))).toEqual(['--tag=rc', '--tag=latest'])
  })

  it('honours NPM_TAG for every tarball', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz', 'b-5.0.0-beta.0.tgz'])
    process.env.NPM_TAG = 'legacy'
    main()
    expect(npmArgs().map(args => args.at(-1))).toEqual(['--tag=legacy', '--tag=legacy'])
  })

  it.each(['-bad', 'has space', '1.2.3'])('rejects an invalid NPM_TAG (%s)', (tag) => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.NPM_TAG = tag
    expect(() => main()).toThrow(/NPM_TAG is not a valid dist-tag/)
  })
})

describe('distTag', () => {
  it.each([
    ['1.2.3', 'latest'],
    ['5.0.0-beta.0', 'beta'],
    ['5.0.0-rc.1', 'rc'],
    ['5.0.0-0', 'next'],
    ['5.0.0-alpha', 'alpha'],
    ['5.0.0-alpha.beta.0', 'alpha.beta'],
    ['5.0.0-pre-view.0', 'pre-view'],
    ['5.0.0-1.2', 'next'],
    ['5.0.0-beta.0+build.1', 'beta'],
    ['1.2.3+build.1', 'latest'],
  ])('maps %s to %s', (version, tag) => {
    expect(distTag(version)).toBe(tag)
  })
})

describe('versionFromTarballName', () => {
  it('extracts the version', () => {
    expect(versionFromTarballName('nuxt-kit-5.0.0-beta.0.tgz')).toBe('5.0.0-beta.0')
    expect(versionFromTarballName('a-1.0.0.tgz')).toBe('1.0.0')
  })

  it('returns null for an unversioned filename', () => {
    expect(versionFromTarballName('bundle.tgz')).toBe(null)
  })
})
