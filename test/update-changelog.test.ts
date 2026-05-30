import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildBumpFileSet, incVersion } from '../scripts/update-changelog.ts'
import { resolveWorkspaces } from '../scripts/_workspaces.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'uppt-bump-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writePackage (relDir: string, contents: Record<string, unknown>) {
  const dir = resolve(tmp, relDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(contents, null, 2))
}

describe('incVersion', () => {
  it('bumps patch', () => {
    expect(incVersion('1.2.3', 'patch')).toBe('1.2.4')
  })

  it('bumps minor and resets patch', () => {
    expect(incVersion('1.2.3', 'minor')).toBe('1.3.0')
  })

  it('bumps major and resets minor and patch', () => {
    expect(incVersion('1.2.3', 'major')).toBe('2.0.0')
  })

  it('throws on a prerelease version', () => {
    expect(() => incVersion('1.2.3-rc.1', 'patch')).toThrowError(/strict "X\.Y\.Z" semver/)
  })

  it('throws on a version with build metadata', () => {
    expect(() => incVersion('1.2.3+sha.abc', 'patch')).toThrowError(/strict "X\.Y\.Z" semver/)
  })

  it('throws on a non-semver string', () => {
    expect(() => incVersion('not-a-version', 'patch')).toThrowError(/strict "X\.Y\.Z" semver/)
  })
})

describe('buildBumpFileSet', () => {
  describe('single-package mode', () => {
    it('rewrites the root package.json with the new version', () => {
      const files = buildBumpFileSet({
        monorepo: false,
        workspaces: [],
        rootPkg: { name: 'pkg', version: '1.2.3' },
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })
      expect(files).toEqual([
        { path: 'package.json', content: `${JSON.stringify({ name: 'pkg', version: '1.2.4' }, null, 2)}\n` },
      ])
    })

    it('preserves other root fields', () => {
      const files = buildBumpFileSet({
        monorepo: false,
        workspaces: [],
        rootPkg: { name: 'pkg', version: '1.2.3', description: 'hello', private: false },
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })
      const written = JSON.parse(files[0]!.content)
      expect(written).toEqual({ name: 'pkg', version: '1.2.4', description: 'hello', private: false })
    })
  })

  describe('monorepo mode', () => {
    it('rewrites every workspace package.json', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3' })
      writePackage('packages/b', { name: 'b', version: '1.2.3' })
      const workspaces = resolveWorkspaces(tmp, 'packages/*')

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg: { name: 'root', private: true },
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      const byPath = Object.fromEntries(files.map(f => [f.path, JSON.parse(f.content)]))
      expect(byPath['packages/a/package.json']).toMatchObject({ name: 'a', version: '1.2.4' })
      expect(byPath['packages/b/package.json']).toMatchObject({ name: 'b', version: '1.2.4' })
    })

    it('leaves the root alone when it has no version', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3' })
      const workspaces = resolveWorkspaces(tmp, 'packages/a')

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg: { name: 'root', private: true },
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      expect(files.map(f => f.path)).toEqual(['packages/a/package.json'])
    })

    it('bumps the root when its version equals the current lockstep', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3' })
      const workspaces = resolveWorkspaces(tmp, 'packages/a')

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg: { name: 'root', version: '1.2.3', private: true },
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      const rootFile = files.find(f => f.path === 'package.json')!
      expect(JSON.parse(rootFile.content)).toMatchObject({ name: 'root', version: '1.2.4', private: true })
    })

    it('leaves the root alone when its version differs from the lockstep', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3' })
      const workspaces = resolveWorkspaces(tmp, 'packages/a')

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg: { name: 'root', version: '0.0.0', private: true },
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      expect(files.map(f => f.path)).toEqual(['packages/a/package.json'])
    })

    it('preserves unrelated workspace fields', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3', dependencies: { foo: 'workspace:^' } })
      const workspaces = resolveWorkspaces(tmp, 'packages/a')

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg: { name: 'root', private: true },
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      expect(JSON.parse(files[0]!.content)).toEqual({
        name: 'a',
        version: '1.2.4',
        dependencies: { foo: 'workspace:^' },
      })
    })
  })
})
