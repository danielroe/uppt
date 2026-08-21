import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildBumpFileSet, buildIndependentBody, determineBump, formatChangelog, buildIndependentBumpFileSet, computeIndependentPlan, extractPreamble, incVersion, latestLockstepTag, latestTagForPackage, releaseBranchDrift, type Commit } from '../scripts/update-changelog.ts'
import { resolveWorkspaces } from '../scripts/_workspaces.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'uppt-bump-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writePackage (relDir: string, contents: Record<string, unknown>, opts: { indent?: string | number, trailingNewline?: string } = {}) {
  const dir = resolve(tmp, relDir)
  mkdirSync(dir, { recursive: true })
  const indent = opts.indent ?? 2
  const trailingNewline = opts.trailingNewline ?? ''
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(contents, null, indent) + trailingNewline)
}

function sourceOf (pkg: Record<string, unknown>): string {
  return JSON.stringify(pkg, null, 2) + '\n'
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

  it('maps a major bump in 0.x.y to the minor slot', () => {
    expect(incVersion('0.2.3', 'major')).toBe('0.3.0')
  })

  it('maps minor and patch bumps in 0.x.y to the patch slot', () => {
    expect(incVersion('0.2.3', 'minor')).toBe('0.2.4')
    expect(incVersion('0.2.3', 'patch')).toBe('0.2.4')
  })

  it('supports 0.0.x versions with the same 0.x.y mapping', () => {
    expect(incVersion('0.0.3', 'major')).toBe('0.1.0')
    expect(incVersion('0.0.3', 'minor')).toBe('0.0.4')
    expect(incVersion('0.0.3', 'patch')).toBe('0.0.4')
  })

  it('graduates a bare-number prerelease regardless of bump level', () => {
    expect(incVersion('5.0.0-0', 'patch')).toBe('5.0.0')
    expect(incVersion('5.0.0-0', 'minor')).toBe('5.0.0')
    expect(incVersion('5.0.0-0', 'major')).toBe('5.0.0')
  })

  it('graduates a dotted-identifier prerelease', () => {
    expect(incVersion('5.0.0-beta.3', 'patch')).toBe('5.0.0')
    expect(incVersion('1.2.3-rc.1', 'major')).toBe('1.2.3')
  })

  it('cuts a new prerelease line from a stable version', () => {
    expect(incVersion('4.5.2', 'major', 'beta')).toBe('5.0.0-beta.0')
    expect(incVersion('4.5.2', 'minor', 'rc')).toBe('4.6.0-rc.0')
  })

  it('increments the counter when the identifier matches', () => {
    expect(incVersion('5.0.0-beta.0', 'major', 'beta')).toBe('5.0.0-beta.1')
    expect(incVersion('5.0.0-beta.3', 'patch', 'beta')).toBe('5.0.0-beta.4')
  })

  it('resets the counter when the identifier changes', () => {
    expect(incVersion('5.0.0-beta.3', 'major', 'rc')).toBe('5.0.0-rc.0')
    expect(incVersion('5.0.0-0', 'patch', 'beta')).toBe('5.0.0-beta.0')
  })

  it('supports bare-number prereleases', () => {
    expect(incVersion('4.5.2', 'major', '0')).toBe('5.0.0-0')
    expect(incVersion('5.0.0-0', 'major', '0')).toBe('5.0.0-1')
    expect(incVersion('5.0.0-beta.3', 'patch', '0')).toBe('5.0.0-0')
  })

  it('treats a bare-number identifier as a style selector, starting new lines at 0', () => {
    expect(incVersion('4.5.2', 'major', '3')).toBe('5.0.0-0')
    expect(incVersion('5.0.0-beta.3', 'patch', '7')).toBe('5.0.0-0')
  })

  it('rejects unsafe prerelease identifiers', () => {
    expect(() => incVersion('4.5.2', 'patch', '--upload-pack=x')).toThrowError(/Invalid prerelease identifier/)
    expect(() => incVersion('4.5.2', 'patch', 'beta bang')).toThrowError(/Invalid prerelease identifier/)
    expect(() => incVersion('4.5.2', 'patch', 'BETA')).toThrowError(/Invalid prerelease identifier/)
    expect(() => incVersion('4.5.2', 'patch', '')).toThrowError(/Invalid prerelease identifier/)
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
      const rootPkg = { name: 'pkg', version: '1.2.3' }
      const files = buildBumpFileSet({
        monorepo: false,
        workspaces: [],
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })
      expect(files).toEqual([
        { path: 'package.json', content: `${JSON.stringify({ name: 'pkg', version: '1.2.4' }, null, 2)}\n` },
      ])
    })

    it('preserves other root fields', () => {
      const rootPkg = { name: 'pkg', version: '1.2.3', description: 'hello', private: false }
      const files = buildBumpFileSet({
        monorepo: false,
        workspaces: [],
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })
      const written = JSON.parse(files[0]!.content)
      expect(written).toEqual({ name: 'pkg', version: '1.2.4', description: 'hello', private: false })
    })

    it('preserves the existing indentation of the root package.json', () => {
      const rootPkg = { name: 'pkg', version: '1.2.3' }
      const tabSource = '{\n\t"name": "pkg",\n\t"version": "1.2.3"\n}\n'
      const files = buildBumpFileSet({
        monorepo: false,
        workspaces: [],
        rootPkg,
        rootPkgSource: tabSource,
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })
      expect(files[0]!.content).toBe('{\n\t"name": "pkg",\n\t"version": "1.2.4"\n}\n')
    })
  })

  describe('monorepo mode', () => {
    it('rewrites every workspace package.json', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3' })
      writePackage('packages/b', { name: 'b', version: '1.2.3' })
      const workspaces = resolveWorkspaces(tmp, 'packages/*')
      const rootPkg = { name: 'root', private: true }

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
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
      const rootPkg = { name: 'root', private: true }

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      expect(files.map(f => f.path)).toEqual(['packages/a/package.json'])
    })

    it('bumps the root when its version equals the current lockstep', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3' })
      const workspaces = resolveWorkspaces(tmp, 'packages/a')
      const rootPkg = { name: 'root', version: '1.2.3', private: true }

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      const rootFile = files.find(f => f.path === 'package.json')!
      expect(JSON.parse(rootFile.content)).toMatchObject({ name: 'root', version: '1.2.4', private: true })
    })

    it('leaves the root alone when its version differs from the lockstep', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3' })
      const workspaces = resolveWorkspaces(tmp, 'packages/a')
      const rootPkg = { name: 'root', version: '0.0.0', private: true }

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      expect(files.map(f => f.path)).toEqual(['packages/a/package.json'])
    })

    it('writes the root only once when it is itself a listed workspace', () => {
      writePackage('.', { name: 'root-pkg', version: '1.2.3' })
      const workspaces = resolveWorkspaces(tmp, '**')
      const rootPkg = { name: 'root-pkg', version: '1.2.3' }

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      expect(files.map(f => f.path)).toEqual(['package.json'])
      expect(JSON.parse(files[0]!.content)).toMatchObject({ version: '1.2.4' })
    })

    it('preserves unrelated workspace fields', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3', dependencies: { foo: 'workspace:^' } })
      const workspaces = resolveWorkspaces(tmp, 'packages/a')
      const rootPkg = { name: 'root', private: true }

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      expect(JSON.parse(files[0]!.content)).toEqual({
        name: 'a',
        version: '1.2.4',
        dependencies: { foo: 'workspace:^' },
      })
    })

    it('preserves each workspace package.json indentation independently', () => {
      writePackage('packages/a', { name: 'a', version: '1.2.3' }, { indent: '\t', trailingNewline: '\n' })
      writePackage('packages/b', { name: 'b', version: '1.2.3' }, { indent: 4, trailingNewline: '\n' })
      const workspaces = resolveWorkspaces(tmp, 'packages/*')
      const rootPkg = { name: 'root', private: true }

      const files = buildBumpFileSet({
        monorepo: true,
        workspaces,
        rootPkg,
        rootPkgSource: sourceOf(rootPkg),
        currentVersion: '1.2.3',
        newVersion: '1.2.4',
      })

      const byPath = Object.fromEntries(files.map(f => [f.path, f.content]))
      expect(byPath['packages/a/package.json']).toBe('{\n\t"name": "a",\n\t"version": "1.2.4"\n}\n')
      expect(byPath['packages/b/package.json']).toBe('{\n    "name": "b",\n    "version": "1.2.4"\n}\n')
    })
  })
})

describe('latestTagForPackage', () => {
  const fontaineTags = [
    'fontaine@0.8.0',
    'fontless@0.2.1',
    'fontaine@0.7.0',
    'fontless@0.2.0',
    'v0.6.0',
    'v0.5.0',
    '0.2.3',
    '0.2.2',
  ]

  it('matches only the package own <name>@X.Y.Z tags', () => {
    expect(latestTagForPackage('fontaine', fontaineTags)?.name).toBe('fontaine@0.8.0')
    expect(latestTagForPackage('fontless', fontaineTags)?.name).toBe('fontless@0.2.1')
  })

  it('never matches bare or lockstep tags to a package', () => {
    expect(latestTagForPackage('foo', ['0.2.3', 'v0.6.0'])).toBeNull()
  })

  it('parses scoped package names', () => {
    const tag = latestTagForPackage('@nuxt/kit', ['@nuxt/kit@5.0.0', 'nuxt@5.0.0', 'v4.2.0'])
    expect(tag).toEqual({ name: '@nuxt/kit@5.0.0', ref: 'refs/tags/@nuxt/kit@5.0.0' })
  })

  it('does not match a longer package name sharing a prefix', () => {
    expect(latestTagForPackage('font', fontaineTags)).toBeNull()
  })

  it('picks the highest version even when list order contradicts it', () => {
    expect(latestTagForPackage('fontaine', ['fontaine@0.8.0', 'fontaine@0.8.1'])?.name).toBe('fontaine@0.8.1')
    expect(latestTagForPackage('fontaine', ['fontaine@1.0.0', 'fontaine@0.9.9'])?.name).toBe('fontaine@1.0.0')
    expect(latestTagForPackage('fontaine', ['fontaine@0.9.9', 'fontaine@1.0.0'])?.name).toBe('fontaine@1.0.0')
  })

  it('compares version components numerically, not lexically', () => {
    expect(latestTagForPackage('fontaine', ['fontaine@0.8.0', 'fontaine@0.8.10', 'fontaine@0.8.9'])?.name).toBe('fontaine@0.8.10')
  })

  it('sorts a stable version above its own prereleases', () => {
    expect(latestTagForPackage('fontaine', ['fontaine@1.0.0-beta.1', 'fontaine@1.0.0'])?.name).toBe('fontaine@1.0.0')
    expect(latestTagForPackage('fontaine', ['fontaine@1.0.0', 'fontaine@1.0.1-beta.1'])?.name).toBe('fontaine@1.0.1-beta.1')
  })
})

describe('latestLockstepTag', () => {
  it('finds the newest v-prefixed tag, skipping bare and per-package tags', () => {
    const tag = latestLockstepTag(['fontaine@0.8.0', '0.2.3', 'v0.6.0', 'v0.5.0'])
    expect(tag?.name).toBe('v0.6.0')
  })

  it('returns null when no lockstep tag exists', () => {
    expect(latestLockstepTag(['fontaine@0.8.0', '0.2.3'])).toBeNull()
  })

  it('picks the highest version regardless of list order', () => {
    expect(latestLockstepTag(['v0.5.0', 'v0.6.0'])?.name).toBe('v0.6.0')
    expect(latestLockstepTag(['v0.8.9', 'v0.8.10'])?.name).toBe('v0.8.10')
  })
})

describe('computeIndependentPlan', () => {
  let hashCounter = 0
  function commit (subject: string): Commit {
    const header = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/)
    const hash = (++hashCounter).toString(16).padStart(40, '0')
    return {
      hash,
      shortHash: hash.slice(0, 7),
      message: subject,
      type: header?.[1]?.toLowerCase() ?? '',
      scope: header?.[2] ?? '',
      description: header?.[4] ?? subject,
      isBreaking: Boolean(header?.[3]),
      author: { name: 'Test', email: 'test@example.com' },
      references: [],
    }
  }

  function fontaineWorkspaces () {
    writePackage('packages/fontaine', { name: 'fontaine', version: '0.8.0' })
    writePackage('packages/fontless', {
      name: 'fontless',
      version: '0.2.1',
      dependencies: { fontaine: 'workspace:*' },
    })
    return resolveWorkspaces(tmp, 'packages/*')
  }

  const fontaineTags = ['fontaine@0.8.0', 'fontless@0.2.1', 'v0.6.0', '0.2.3']

  it('releases fontaine on its own commit and fontless via propagation', () => {
    const plan = computeIndependentPlan({
      workspaces: fontaineWorkspaces(),
      scopeOverrides: new Map(),
      tags: fontaineTags,
      commits: [commit('feat(fontaine): add metric overrides')],
    })

    expect(plan.releases.map(r => r.name)).toEqual(['fontaine', 'fontless'])
    const [fontaine, fontless] = plan.releases
    expect(fontaine).toMatchObject({
      currentVersion: '0.8.0',
      newVersion: '0.8.1',
      bump: 'minor',
      ownCommits: true,
      fromTag: { name: 'fontaine@0.8.0', ref: 'refs/tags/fontaine@0.8.0' },
    })
    expect(fontaine!.commits).toHaveLength(1)
    expect(fontless).toMatchObject({
      currentVersion: '0.2.1',
      newVersion: '0.2.2',
      bump: 'patch',
      ownCommits: false,
      commits: [],
    })
    expect(plan.unrouted).toEqual([])
  })

  it('routes unscoped and unknown-scope commits to unrouted and bumps nothing', () => {
    const unscoped = commit('fix: something repo-wide')
    const unknown = commit('feat(playground): shiny demo')
    const plan = computeIndependentPlan({
      workspaces: fontaineWorkspaces(),
      scopeOverrides: new Map(),
      tags: fontaineTags,
      commits: [unscoped, unknown],
    })

    expect(plan.releases).toEqual([])
    expect(plan.unrouted).toEqual([unscoped, unknown])
  })

  it('bumps each package from its own commits only', () => {
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/b', { name: 'b', version: '2.0.0' })
    const plan = computeIndependentPlan({
      workspaces: resolveWorkspaces(tmp, 'packages/*'),
      scopeOverrides: new Map(),
      tags: ['a@1.0.0', 'b@2.0.0'],
      commits: [commit('feat(a): new thing'), commit('fix(b): small thing')],
    })

    const byName = Object.fromEntries(plan.releases.map(r => [r.name, r]))
    expect(byName.a).toMatchObject({ newVersion: '1.1.0', bump: 'minor', ownCommits: true })
    expect(byName.b).toMatchObject({ newVersion: '2.0.1', bump: 'patch', ownCommits: true })
  })

  it('falls back to the lockstep tag for a package with no per-package tag', () => {
    const plan = computeIndependentPlan({
      workspaces: fontaineWorkspaces(),
      scopeOverrides: new Map(),
      tags: ['fontaine@0.8.0', 'v0.6.0', '0.2.3'],
      commits: [commit('fix(fontless): resolve fallback fonts')],
    })

    expect(plan.releases).toHaveLength(1)
    expect(plan.releases[0]).toMatchObject({
      name: 'fontless',
      currentVersion: '0.2.1',
      newVersion: '0.2.2',
      fromTag: { name: 'v0.6.0', ref: 'refs/tags/v0.6.0' },
    })
  })

  it('filters each package commits by its own tag boundary', () => {
    const old = commit('feat(fontaine): already shipped in 0.8.0')
    const fresh = commit('fix(fontless): new since fontless@0.2.1')
    const plan = computeIndependentPlan({
      workspaces: fontaineWorkspaces(),
      scopeOverrides: new Map(),
      tags: fontaineTags,
      commits: [fresh, old],
      isCommitSince: c => c === fresh,
    })

    expect(plan.releases.map(r => r.name)).toEqual(['fontless'])
    expect(plan.releases[0]!.commits).toEqual([fresh])
  })

  it('honours scope overrides when routing', () => {
    const plan = computeIndependentPlan({
      workspaces: fontaineWorkspaces(),
      scopeOverrides: new Map([['fontaine', ['core']]]),
      tags: fontaineTags,
      commits: [commit('feat(core): overridden scope'), commit('feat(fontaine): now unrouted')],
    })

    const fontaine = plan.releases.find(r => r.name === 'fontaine')
    expect(fontaine?.commits.map(c => c.scope)).toEqual(['core'])
    expect(plan.unrouted.map(c => c.scope)).toEqual(['fontaine'])
  })

  it('applies the prerelease identifier to every computed version', () => {
    const plan = computeIndependentPlan({
      workspaces: fontaineWorkspaces(),
      scopeOverrides: new Map(),
      tags: fontaineTags,
      commits: [commit('feat(fontaine): big change')],
      prerelease: 'beta',
    })

    const byName = Object.fromEntries(plan.releases.map(r => [r.name, r.newVersion]))
    expect(byName.fontaine).toBe('0.8.1-beta.0')
    expect(byName.fontless).toBe('0.2.2-beta.0')
  })
})

describe('extractPreamble', () => {
  it('returns everything above the first generated heading', () => {
    expect(extractPreamble('> intro\n\n## 👉 Changelog\n\nstuff')).toBe('> intro')
    expect(extractPreamble('> intro\n\n## 👉 Pending releases\n\n- a\n\n## 👉 Changelog\n\nstuff')).toBe('> intro')
  })

  it('returns null for empty bodies or bodies starting with a generated heading', () => {
    expect(extractPreamble(null)).toBeNull()
    expect(extractPreamble('')).toBeNull()
    expect(extractPreamble('## 👉 Changelog\n\nstuff')).toBeNull()
  })

  it('returns the whole body when no generated heading exists', () => {
    expect(extractPreamble('> just a note')).toBe('> just a note')
  })
})

describe('independent release PR', () => {
  let hashCounter = 0
  function commit (subject: string): Commit {
    const header = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/)
    const hash = (++hashCounter).toString(16).padStart(40, '0')
    return {
      hash,
      shortHash: hash.slice(0, 7),
      message: subject,
      type: header?.[1]?.toLowerCase() ?? '',
      scope: header?.[2] ?? '',
      description: header?.[4] ?? subject,
      isBreaking: Boolean(header?.[3]),
      author: { name: 'Test', email: 'test@example.com' },
      references: [],
    }
  }

  function fontaineWorkspaces () {
    writePackage('packages/fontaine', { name: 'fontaine', version: '0.8.0' }, { indent: '\t', trailingNewline: '\n' })
    writePackage('packages/fontless', {
      name: 'fontless',
      version: '0.2.1',
      dependencies: { fontaine: 'workspace:*' },
    }, { trailingNewline: '\n' })
    writePackage('.', { name: 'root', private: true, version: '0.0.0' })
    return resolveWorkspaces(tmp, 'packages/*')
  }

  const fontaineTags = ['fontaine@0.8.0', 'fontless@0.2.1']
  const bodyOpts = { owner: 'unjs', repo: 'fontaine', branch: 'release/main-pending', preamble: '> intro' }

  function fontainePlan (commits: Commit[]) {
    return computeIndependentPlan({
      workspaces: fontaineWorkspaces(),
      scopeOverrides: new Map(),
      tags: fontaineTags,
      commits,
    })
  }

  it('renders one changelog section per released package, in publish order', () => {
    const body = buildIndependentBody(fontainePlan([commit('feat(fontaine): add metric overrides')]), bodyOpts)

    const fontaineIndex = body.indexOf('### fontaine (0.8.0 → 0.8.1)')
    const fontlessIndex = body.indexOf('### fontless (0.2.1 → 0.2.2)')
    expect(fontaineIndex).toBeGreaterThan(-1)
    expect(fontlessIndex).toBeGreaterThan(fontaineIndex)
    expect(body).toContain('add metric overrides')
  })

  it('drops the package scope when it matches the section it renders in', () => {
    const body = buildIndependentBody(fontainePlan([commit('fix(fontaine): don\'t add fallbacks to generic families')]), bodyOpts)

    expect(body).toContain('- don\'t add fallbacks to generic families')
    expect(body).not.toContain('**fontaine:**')
  })

  it('routes a comma-separated scope to every named package, keeping the full scope list', () => {
    const plan = fontainePlan([commit('fix(fontaine,fontless): shared fix')])
    const body = buildIndependentBody(plan, bodyOpts)

    expect(plan.unrouted).toHaveLength(0)
    expect(plan.releases.map(r => `${r.name}@${r.newVersion}`)).toEqual(['fontaine@0.8.1', 'fontless@0.2.2'])
    expect(body.match(/\*\*fontaine,fontless:\*\* shared fix/g)).toHaveLength(2)
  })

  it('ignores unknown scopes alongside a known one', () => {
    const plan = fontainePlan([commit('fix(fontaine,docs): partly known')])

    expect(plan.unrouted).toHaveLength(0)
    expect(plan.releases.find(r => r.name === 'fontaine')?.commits).toHaveLength(1)
  })

  it('keeps a scope the section does not own, and renders unscoped commits unchanged', () => {
    const changelog = formatChangelog(
      [commit('fix(ci): tighten workflow'), commit('fix: unscoped thing')],
      { owner: 'unjs', repo: 'fontaine', fromRef: null, toRef: 'main', packageScopes: ['fontaine'] },
    )

    expect(changelog).toContain('**ci:** tighten workflow')
    expect(changelog).toContain('- unscoped thing')
  })

  it('leaves scopes alone for fixed (lockstep) changelogs', () => {
    const changelog = formatChangelog(
      [commit('fix(fontaine): a fix')],
      { owner: 'unjs', repo: 'fontaine', fromRef: null, toRef: 'main' },
    )

    expect(changelog).toContain('**fontaine:** a fix')
  })

  it('notes the propagation cause for dependency-only releases', () => {
    const body = buildIndependentBody(fontainePlan([commit('feat(fontaine): add metric overrides')]), bodyOpts)

    expect(body).toContain('_Released because `fontaine` was bumped; no direct changes._')
    expect(body).not.toMatch(/### fontless[\s\S]*compare changes/)
  })

  it('renders unrouted commits in their own section', () => {
    const plan = fontainePlan([commit('feat(fontaine): thing'), commit('docs: update readme')])
    const body = buildIndependentBody(plan, bodyOpts)

    expect(body).toContain('### 📝 Other commits')
    expect(body).toContain('not routed to any package')
    expect(body).toContain('docs: update readme')
  })

  it('omits the unrouted section when every commit is routed', () => {
    const body = buildIndependentBody(fontainePlan([commit('feat(fontaine): thing')]), bodyOpts)
    expect(body).not.toContain('Other commits')
  })

  it('preserves the preamble across regenerations', () => {
    const plan = fontainePlan([commit('feat(fontaine): thing')])
    const first = buildIndependentBody(plan, { ...bodyOpts, preamble: '> hand-written notes' })
    const second = buildIndependentBody(plan, { ...bodyOpts, preamble: extractPreamble(first)! })
    expect(second).toBe(first)
  })

  it('shrinks when a package drops out of the plan', () => {
    const workspaces = fontaineWorkspaces()
    const full = buildIndependentBody(computeIndependentPlan({
      workspaces,
      scopeOverrides: new Map(),
      tags: fontaineTags,
      commits: [commit('feat(fontaine): thing')],
    }), bodyOpts)
    const shrunk = buildIndependentBody(computeIndependentPlan({
      workspaces,
      scopeOverrides: new Map(),
      tags: fontaineTags,
      commits: [commit('fix(fontless): only fontless now')],
    }), bodyOpts)

    expect(full).toContain('### fontaine')
    expect(shrunk).not.toContain('### fontaine')
    expect(shrunk).toContain('### fontless (0.2.1 → 0.2.2)')
  })

  it('renders the contributor sections when contributors are provided', () => {
    const body = buildIndependentBody(fontainePlan([commit('feat(fontaine): thing')]), {
      ...bodyOpts,
      contributors: [
        { name: 'Ada', username: 'ada', isFirstTime: true },
        { name: 'Grace', username: 'grace', isFirstTime: false },
      ],
    })

    expect(body).toContain('### 🎉 New Contributors\n\n- Ada (@ada)')
    expect(body).toContain('### ❤️ Contributors\n\n- Ada (@ada)\n- Grace (@grace)')
  })

  it('commits exactly the released manifests, preserving formatting and skipping the root', () => {
    const files = buildIndependentBumpFileSet(fontainePlan([commit('feat(fontaine): thing')]))

    expect(files.map(f => f.path).sort()).toEqual(['packages/fontaine/package.json', 'packages/fontless/package.json'])
    const byPath = Object.fromEntries(files.map(f => [f.path, f.content]))
    expect(byPath['packages/fontaine/package.json']).toBe('{\n\t"name": "fontaine",\n\t"version": "0.8.1"\n}\n')
    expect(JSON.parse(byPath['packages/fontless/package.json']!)).toEqual({
      name: 'fontless',
      version: '0.2.2',
      dependencies: { fontaine: 'workspace:*' },
    })
    expect(byPath['packages/fontless/package.json']!.endsWith('\n')).toBe(true)
  })

  it('throws when a planned package has no version field', () => {
    writePackage('packages/a', { name: 'a' })
    expect(() => computeIndependentPlan({
      workspaces: resolveWorkspaces(tmp, 'packages/a'),
      scopeOverrides: new Map([['a', ['a']]]),
      tags: [],
      commits: [commit('fix(a): thing')],
    })).toThrow(/has no `version` field/)
  })

  it('ignores a self-referential workspace dependency when naming propagation causes', () => {
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/b', { name: 'b', version: '2.0.0', dependencies: { a: 'workspace:*', b: 'workspace:*' } })
    const body = buildIndependentBody(computeIndependentPlan({
      workspaces: resolveWorkspaces(tmp, 'packages/*'),
      scopeOverrides: new Map(),
      tags: ['a@1.0.0', 'b@2.0.0'],
      commits: [commit('fix(a): thing')],
    }), bodyOpts)
    expect(body).toContain('_Released because `a` was bumped; no direct changes._')
  })

  it('skips dependency fields that are absent or not objects', () => {
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/b', {
      name: 'b',
      version: '2.0.0',
      dependencies: { a: 'workspace:*', external: '^1.0.0' },
      optionalDependencies: 'not-an-object',
    })
    const body = buildIndependentBody(computeIndependentPlan({
      workspaces: resolveWorkspaces(tmp, 'packages/*'),
      scopeOverrides: new Map(),
      tags: ['a@1.0.0', 'b@2.0.0'],
      commits: [commit('fix(a): thing')],
    }), bodyOpts)
    expect(body).toContain('_Released because `a` was bumped; no direct changes._')
  })

  it('renders a placeholder when there are no contributors at all', () => {
    const body = buildIndependentBody(fontainePlan([commit('feat(fontaine): thing')]), {
      ...bodyOpts,
      contributors: [],
    })
    expect(body).toContain('### ❤️ Contributors\n\n_no contributors yet_')
    expect(body).not.toContain('New Contributors')
  })

  it('bumps the root manifest when the root is itself a planned release', () => {
    writePackage('.', { name: 'root-pkg', version: '1.0.0' })
    const files = buildIndependentBumpFileSet(computeIndependentPlan({
      workspaces: resolveWorkspaces(tmp, '**'),
      scopeOverrides: new Map(),
      tags: ['root-pkg@1.0.0'],
      commits: [commit('fix(root-pkg): thing')],
    }))
    expect(files.map(f => f.path)).toEqual(['package.json'])
  })

  it('bumps only the released package when nothing propagates', () => {
    writePackage('packages/a', { name: 'a', version: '1.0.0' })
    writePackage('packages/b', { name: 'b', version: '2.0.0' })
    const files = buildIndependentBumpFileSet(computeIndependentPlan({
      workspaces: resolveWorkspaces(tmp, 'packages/*'),
      scopeOverrides: new Map(),
      tags: ['a@1.0.0', 'b@2.0.0'],
      commits: [commit('fix(a): thing')],
    }))

    expect(files.map(f => f.path)).toEqual(['packages/a/package.json'])
  })
})

describe('determineBump', () => {
  function commit (overrides: Partial<Commit>): Commit {
    return {
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      message: 'chore: thing',
      type: 'chore',
      scope: '',
      description: 'thing',
      isBreaking: false,
      author: { name: 'Test', email: 'test@example.com' },
      references: [],
      ...overrides,
    }
  }

  it('bumps major for a breaking change', () => {
    expect(determineBump([commit({}), commit({ isBreaking: true })])).toBe('major')
  })

  it('bumps minor for a feature', () => {
    expect(determineBump([commit({ type: 'feat' })])).toBe('minor')
  })

  it('bumps patch for anything else', () => {
    expect(determineBump([commit({ type: 'fix' })])).toBe('patch')
  })

  it('renders breaking changes with a warning marker and skips unknown types', () => {
    const changelog = formatChangelog(
      [
        commit({ type: 'feat', description: 'new thing', isBreaking: true }),
        commit({ type: 'wip', description: 'not a known type' }),
      ],
      { owner: 'owner', repo: 'repo', fromRef: null, toRef: 'main' },
    )
    expect(changelog).toContain('- ⚠️  new thing')
    expect(changelog).not.toContain('not a known type')
  })
})

describe('releaseBranchDrift', () => {
  const desired = new Map([['packages/a/package.json', '{"version":"1.1.0"}\n']])
  const inSync = {
    divergence: { changed: new Set(['packages/a/package.json']), mergeBase: 'abc', behindBy: 0 },
    desired,
    branchContents: new Map([['packages/a/package.json', '{"version":"1.1.0"}\n']]),
    baseTouched: [],
  }

  it('leaves an up-to-date branch alone', () => {
    expect(releaseBranchDrift(inSync)).toBe(null)
  })

  it('leaves a branch that is merely behind base alone', () => {
    expect(releaseBranchDrift({
      ...inSync,
      divergence: { ...inSync.divergence, behindBy: 12 },
    })).toBe(null)
  })

  it('rebuilds when the branch does not exist', () => {
    expect(releaseBranchDrift({ ...inSync, divergence: null })).toBe('branch does not exist')
  })

  it('rebuilds when the branch bumps a package the plan no longer includes', () => {
    expect(releaseBranchDrift({
      ...inSync,
      divergence: {
        ...inSync.divergence,
        changed: new Set(['packages/a/package.json', 'packages/b/package.json']),
      },
    })).toMatch(/packages\/b\/package\.json/)
  })

  it('rebuilds when the branch holds a stale version', () => {
    expect(releaseBranchDrift({
      ...inSync,
      branchContents: new Map([['packages/a/package.json', '{"version":"1.0.1"}\n']]),
    })).toBe('packages/a/package.json differs from the plan')
  })

  it('rebuilds when the branch carries no diff at all', () => {
    expect(releaseBranchDrift({
      ...inSync,
      divergence: { ...inSync.divergence, changed: new Set() },
    })).toBe('branch changes nothing, plan changes packages/a/package.json')
  })

  it('rebuilds when base has since touched the same manifest', () => {
    expect(releaseBranchDrift({
      ...inSync,
      divergence: { ...inSync.divergence, behindBy: 3 },
      baseTouched: ['packages/a/package.json'],
    })).toBe('base has since changed packages/a/package.json')
  })
})
