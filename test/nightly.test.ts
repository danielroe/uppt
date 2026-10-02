import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))

const {
  applyNightly,
  nightlyBin,
  nightlyName,
  nightlyTimestamp,
  nightlyVersion,
  parseAliases,
  rewriteManifest,
  validateSuffix,
} = await import('../scripts/nightly.ts')

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

const SHA = '0123456789abcdef0123456789abcdef01234567'
const EPOCH = Date.UTC(2026, 4, 14, 9, 5, 42) / 1000

function mockGit () {
  execFileSync.mockReturnValue(`${SHA} ${EPOCH}`)
}

let root: string

function writePkg (dir: string, pkg: Record<string, unknown>) {
  mkdirSync(resolve(root, dir), { recursive: true })
  writeFileSync(resolve(root, dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

const readPkg = (dir: string) => JSON.parse(readFileSync(resolve(root, dir, 'package.json'), 'utf8'))

beforeEach(() => {
  root = realpathSync(mkdtempSync(resolve(tmpdir(), 'uppt-nightly-')))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  execFileSync.mockReset()
  vi.restoreAllMocks()
})

describe('nightlyTimestamp', () => {
  it('formats the date as YYMMDDHHmm in UTC', () => {
    expect(nightlyTimestamp(new Date(EPOCH * 1000))).toBe('2605140905')
  })
})

describe('nightlyVersion', () => {
  const date = new Date(EPOCH * 1000)

  it('appends timestamp and short sha to the version core', () => {
    expect(nightlyVersion('1.2.3', date, SHA)).toBe('1.2.3-2605140905-0123456')
    expect(nightlyVersion('5.0.0-alpha.1', date, SHA)).toBe('5.0.0-2605140905-0123456')
  })

  it('produces valid semver for an all-digit sha with a leading zero', () => {
    expect(nightlyVersion('1.2.3', date, '0123456aaaa')).toMatch(STRICT_SEMVER)
  })

  it('sorts chronologically as plain strings', () => {
    const versions = [
      nightlyVersion('1.2.3', new Date(Date.UTC(2026, 0, 2)), 'fffffff'),
      nightlyVersion('1.2.3', new Date(Date.UTC(2026, 0, 1, 23, 59)), '0000000'),
      nightlyVersion('1.2.3', new Date(Date.UTC(2026, 9, 1)), 'aaaaaaa'),
    ]
    expect([...versions].sort()).toEqual([versions[1], versions[0], versions[2]])
  })

  it('rejects a malformed sha', () => {
    expect(() => nightlyVersion('1.2.3', date, 'nope')).toThrow(/Invalid commit sha/)
    expect(() => nightlyVersion('latest', date, SHA)).toThrow(/Invalid version/)
  })
})

describe('validateSuffix / nightlyName', () => {
  it('accepts and applies a suffix', () => {
    expect(validateSuffix('-canary')).toBe('-canary')
    expect(nightlyName('@nuxt/test-utils', '-nightly')).toBe('@nuxt/test-utils-nightly')
  })

  it('rejects unsafe suffixes and names', () => {
    expect(() => validateSuffix('-Nightly')).toThrow(/Invalid nightly suffix/)
    expect(() => validateSuffix('')).toThrow(/Invalid nightly suffix/)
    expect(() => nightlyName('pkg', '~~/')).toThrow(/not a valid npm package name/)
  })
})

describe('parseAliases', () => {
  it('parses bare names and explicit targets', () => {
    expect(parseAliases(`
      nuxi
      # comment
      @nuxt/cli: @nuxt/cli-nightly@5x
      h3: h3-next
    `, '-nightly')).toEqual(new Map([
      ['nuxi', 'npm:nuxi-nightly@latest'],
      ['@nuxt/cli', 'npm:@nuxt/cli-nightly@5x'],
      ['h3', 'npm:h3-next@latest'],
    ]))
  })

  it('rejects malformed lines', () => {
    expect(() => parseAliases('a b', '-nightly')).toThrow(/Invalid alias line/)
    expect(() => parseAliases('Foo: bar', '-nightly')).toThrow(/Invalid package name/)
  })
})

describe('nightlyBin', () => {
  it('adds suffixed commands and one matching the renamed package', () => {
    expect(nightlyBin({ nuxi: './a.mjs', nuxt: './b.mjs' }, '@nuxt/cli', '@nuxt/cli-nightly', '-nightly')).toEqual({
      'nuxi': './a.mjs',
      'nuxt': './b.mjs',
      'nuxi-nightly': './a.mjs',
      'nuxt-nightly': './b.mjs',
      'cli-nightly': './a.mjs',
    })
  })

  it('keeps the original command for a string bin', () => {
    expect(nightlyBin('./cli.mjs', 'nuxi', 'nuxi-nightly', '-nightly')).toEqual({
      'nuxi': './cli.mjs',
      'nuxi-nightly': './cli.mjs',
    })
  })

  it('ignores missing or empty bins', () => {
    expect(nightlyBin(undefined, 'a', 'a-nightly', '-nightly')).toBeUndefined()
    expect(nightlyBin({}, 'a', 'a-nightly', '-nightly')).toBeUndefined()
  })
})

describe('rewriteManifest', () => {
  it('renames, versions, and pins internal and aliased dependencies', () => {
    const pkg: Record<string, unknown> = {
      name: 'a',
      version: '1.0.0',
      dependencies: { 'b': 'workspace:*', 'nuxi': 'npm:nuxi@^3.0.0', 'c': 'npm:other@1', 'left-pad': '1' },
      devDependencies: { b: 'npm:b@^1.0.0', nuxi: '^3.0.0' },
      peerDependencies: { b: 'workspace:*' },
      optionalDependencies: { nuxi: '^3.0.0' },
    }
    rewriteManifest(pkg, {
      suffix: '-nightly',
      targets: new Map([
        ['a', { name: 'a-nightly', version: '1.0.1-x' }],
        ['b', { name: 'b-nightly', version: '1.0.1-x' }],
      ]),
      aliases: new Map([['nuxi', 'npm:nuxi-nightly@latest']]),
    })
    expect(pkg).toEqual({
      name: 'a-nightly',
      version: '1.0.1-x',
      dependencies: { 'b': 'npm:b-nightly@1.0.1-x', 'nuxi': 'npm:nuxi-nightly@latest', 'c': 'npm:other@1', 'left-pad': '1' },
      devDependencies: { b: 'npm:b-nightly@1.0.1-x', nuxi: '^3.0.0' },
      peerDependencies: { b: 'npm:b-nightly@1.0.1-x' },
      optionalDependencies: { nuxi: 'npm:nuxi-nightly@latest' },
    })
  })
})

describe('applyNightly', () => {
  it('rewrites the root package', () => {
    mockGit()
    writePkg('.', { name: 'pkg', version: '1.2.3', bin: './cli.mjs' })
    expect(applyNightly(root, { packagesInput: '' })).toEqual([{ name: 'pkg-nightly', version: '1.2.3-2605140905-0123456' }])
    expect(readPkg('.')).toEqual({
      name: 'pkg-nightly',
      version: '1.2.3-2605140905-0123456',
      bin: { 'pkg': './cli.mjs', 'pkg-nightly': './cli.mjs' },
    })
  })

  it('rewrites every listed workspace with a custom suffix and aliases', () => {
    mockGit()
    writePkg('packages/a', { name: '@scope/a', version: '1.2.3', dependencies: { '@scope/b': 'workspace:*', 'nuxi': '^3' } })
    writePkg('packages/b', { name: '@scope/b', version: '1.2.3' })
    writePkg('packages/c', { name: 'c', private: true, version: '0.0.0' })
    applyNightly(root, { packagesInput: 'packages/*', suffix: '-edge', aliases: 'nuxi' })
    expect(readPkg('packages/a')).toEqual({
      name: '@scope/a-edge',
      version: '1.2.3-2605140905-0123456',
      dependencies: { '@scope/b': 'npm:@scope/b-edge@1.2.3-2605140905-0123456', 'nuxi': 'npm:nuxi-edge@latest' },
    })
    expect(readPkg('packages/b').name).toBe('@scope/b-edge')
    expect(readPkg('packages/c').name).toBe('c')
  })

  it('refuses a private root or a package without a version', () => {
    mockGit()
    writePkg('.', { name: 'pkg', version: '1.2.3', private: true })
    expect(() => applyNightly(root, { packagesInput: '' })).toThrow(/private package pkg/)
    writePkg('.', { name: 'pkg' })
    expect(() => applyNightly(root, { packagesInput: '' })).toThrow(/need a "name" and "version"/)
  })
})
