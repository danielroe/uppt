import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))

const { main } = await import('../scripts/publish.ts')

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
  for (const key of ['NPM_ACCESS', 'TARBALL_DIR', 'TARBALL_FILES', 'RELEASES']) delete process.env[key]
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
      ['stage', 'publish', resolve(process.env.TARBALL_DIR!, 'a-1.0.0.tgz'), '--provenance', '--ignore-scripts', '--access=public'],
      ['stage', 'publish', resolve(process.env.TARBALL_DIR!, 'b-1.0.0.tgz'), '--provenance', '--ignore-scripts', '--access=public'],
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
})
