import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  expandPackagePatterns,
  isSemver,
  parsePackagesInput,
  resolveCurrentLockstepVersion,
  resolveWorkspaces,
} from '../scripts/_workspaces.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'uppt-ws-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writePackage (relDir: string, contents: Record<string, unknown>) {
  const dir = resolve(tmp, relDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(contents, null, 2))
}

describe('parsePackagesInput', () => {
  it('returns one entry per non-blank line', () => {
    expect(parsePackagesInput('packages/a\npackages/b\n')).toEqual(['packages/a', 'packages/b'])
  })

  it('strips comments and blank lines', () => {
    const input = `
      # publishable packages
      packages/a

      packages/b  # trailing
    `
    expect(parsePackagesInput(input)).toEqual(['packages/a', 'packages/b'])
  })

  it('preserves negation prefix', () => {
    expect(parsePackagesInput('packages/*\n!packages/playground')).toEqual([
      'packages/*',
      '!packages/playground',
    ])
  })
})

describe('expandPackagePatterns', () => {
  it('expands a literal path', () => {
    writePackage('packages/a', { name: 'a' })
    expect(expandPackagePatterns(tmp, ['packages/a'])).toEqual([resolve(tmp, 'packages/a')])
  })

  it('expands a single-segment glob', () => {
    writePackage('packages/a', { name: 'a' })
    writePackage('packages/b', { name: 'b' })
    expect(expandPackagePatterns(tmp, ['packages/*'])).toEqual([
      resolve(tmp, 'packages/a'),
      resolve(tmp, 'packages/b'),
    ])
  })

  it('skips entries with no package.json', () => {
    writePackage('packages/a', { name: 'a' })
    mkdirSync(resolve(tmp, 'packages/empty'), { recursive: true })
    expect(expandPackagePatterns(tmp, ['packages/*'])).toEqual([resolve(tmp, 'packages/a')])
  })

  it('honours negation', () => {
    writePackage('packages/a', { name: 'a' })
    writePackage('packages/b', { name: 'b' })
    expect(expandPackagePatterns(tmp, ['packages/*', '!packages/b'])).toEqual([
      resolve(tmp, 'packages/a'),
    ])
  })

  it('deduplicates overlapping patterns', () => {
    writePackage('packages/a', { name: 'a' })
    expect(expandPackagePatterns(tmp, ['packages/a', 'packages/*'])).toEqual([
      resolve(tmp, 'packages/a'),
    ])
  })
})

describe('resolveWorkspaces', () => {
  it('returns name/version/dir for each match', () => {
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/b', { name: 'b', version: '1.0.0' })

    const workspaces = resolveWorkspaces(tmp, 'packages/*')
    expect(workspaces).toEqual([
      { dir: resolve(tmp, 'packages/a'), relDir: 'packages/a', name: 'a', version: '1.0.0' },
      { dir: resolve(tmp, 'packages/b'), relDir: 'packages/b', name: 'b', version: '1.0.0' },
    ])
  })

  it('treats a missing version as null', () => {
    writePackage('packages/a', { name: 'a' })
    expect(resolveWorkspaces(tmp, 'packages/a')[0]!.version).toBeNull()
  })

  it('throws when input is empty', () => {
    expect(() => resolveWorkspaces(tmp, '   \n  # comment only\n')).toThrowError(/empty/)
  })

  it('throws when no pattern matches', () => {
    expect(() => resolveWorkspaces(tmp, 'packages/*')).toThrowError(/matched no directories/)
  })

  it('throws when a matched workspace has no name', () => {
    writePackage('packages/a', { version: '1.0.0' })
    expect(() => resolveWorkspaces(tmp, 'packages/a')).toThrowError(/no "name" field/)
  })

  it('silently drops private workspaces matched by a glob', () => {
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/playground', { name: 'playground', version: '1.0.0', private: true })
    const workspaces = resolveWorkspaces(tmp, 'packages/*')
    expect(workspaces.map(ws => ws.name)).toEqual(['a'])
  })

  it('silently drops a private workspace matched by literal path', () => {
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/playground', { name: 'playground', version: '1.0.0', private: true })
    const workspaces = resolveWorkspaces(tmp, 'packages/a\npackages/playground')
    expect(workspaces.map(ws => ws.name)).toEqual(['a'])
  })

  it('does not require a name field on a private workspace', () => {
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/playground', { private: true })
    const workspaces = resolveWorkspaces(tmp, 'packages/*')
    expect(workspaces.map(ws => ws.name)).toEqual(['a'])
  })
})

describe('resolveCurrentLockstepVersion', () => {
  it('prefers the latest tag', () => {
    writePackage('.', { name: 'root', version: '0.5.0', private: true })
    writePackage('packages/a', { name: 'a', version: '0.4.0' })
    const workspaces = resolveWorkspaces(tmp, 'packages/a')
    expect(resolveCurrentLockstepVersion(tmp, 'v1.2.3', workspaces)).toBe('1.2.3')
  })

  it('falls back to root version when no tag', () => {
    writePackage('.', { name: 'root', version: '0.5.0', private: true })
    writePackage('packages/a', { name: 'a', version: '0.4.0' })
    const workspaces = resolveWorkspaces(tmp, 'packages/a')
    expect(resolveCurrentLockstepVersion(tmp, null, workspaces)).toBe('0.5.0')
  })

  it('falls back to consensus across workspaces when root has no version', () => {
    writePackage('.', { name: 'root', private: true })
    writePackage('packages/a', { name: 'a', version: '0.4.0' })
    writePackage('packages/b', { name: 'b', version: '0.4.0' })
    const workspaces = resolveWorkspaces(tmp, 'packages/*')
    expect(resolveCurrentLockstepVersion(tmp, null, workspaces)).toBe('0.4.0')
  })

  it('throws when workspaces disagree and no tag/root version anchors them', () => {
    writePackage('.', { name: 'root', private: true })
    writePackage('packages/a', { name: 'a', version: '0.4.0' })
    writePackage('packages/b', { name: 'b', version: '0.5.0' })
    const workspaces = resolveWorkspaces(tmp, 'packages/*')
    expect(() => resolveCurrentLockstepVersion(tmp, null, workspaces)).toThrowError(/workspaces disagree/)
  })

  it('throws when nothing carries a version', () => {
    writePackage('.', { name: 'root', private: true })
    writePackage('packages/a', { name: 'a' })
    const workspaces = resolveWorkspaces(tmp, 'packages/a')
    expect(() => resolveCurrentLockstepVersion(tmp, null, workspaces)).toThrowError(/no tag, no root version/)
  })
})

describe('isSemver', () => {
  it('accepts plain X.Y.Z', () => {
    expect(isSemver('1.2.3')).toBe(true)
  })

  it('accepts prerelease and build metadata', () => {
    expect(isSemver('1.2.3-rc.1')).toBe(true)
    expect(isSemver('1.2.3+sha.abc')).toBe(true)
  })

  it('rejects non-semver', () => {
    expect(isSemver('1.2')).toBe(false)
    expect(isSemver('v1.2.3')).toBe(false)
    expect(isSemver('not-a-version')).toBe(false)
  })
})
