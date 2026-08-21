import { describe, expect, it } from 'vitest'

import type { Workspace } from '../scripts/_workspaces.ts'
import {
  COORDINATION_TAG_RE,
  coordinationTag,
  deriveReleaseSet,
  expectedTarballName,
  packageTag,
  releaseTitle,
  releasesFromEnv,
  serialiseReleases,
} from '../scripts/_independent.ts'

function ws (name: string, version: string, pkg: Record<string, unknown> = {}): Workspace {
  const full = { name, version, ...pkg }
  const relDir = `packages/${name.split('/').pop()}`
  return {
    dir: `/repo/${relDir}`,
    relDir,
    name,
    version,
    pkg: full,
    source: JSON.stringify(full, null, 2),
  }
}

describe('deriveReleaseSet', () => {
  it('includes packages whose version moved and excludes unchanged ones', () => {
    const set = deriveReleaseSet(
      [ws('a', '1.1.0'), ws('b', '2.0.0')],
      ['a@1.0.0', 'b@2.0.0'],
    )
    expect(set).toEqual([{ name: 'a', version: '1.1.0', dir: 'packages/a' }])
  })

  it('includes packages with no prior tag of any kind', () => {
    const set = deriveReleaseSet([ws('a', '0.1.0')], [])
    expect(set).toEqual([{ name: 'a', version: '0.1.0', dir: 'packages/a' }])
  })

  it('falls back to the lockstep tag when a package has no tag of its own', () => {
    const workspaces = [ws('@nuxt/kit', '4.2.0'), ws('nuxt', '4.2.0')]
    expect(deriveReleaseSet(workspaces, ['v4.2.0', 'v4.1.0'])).toEqual([])
    expect(deriveReleaseSet(workspaces, ['v4.1.0']).map(e => e.name)).toEqual(['@nuxt/kit', 'nuxt'])
  })

  it('prefers a per-package tag over the lockstep fallback', () => {
    const workspaces = [ws('a', '2.0.0')]
    expect(deriveReleaseSet(workspaces, ['a@2.0.0', 'v9.9.9'])).toEqual([])
    expect(deriveReleaseSet(workspaces, ['a@1.0.0', 'v2.0.0']).map(e => e.name)).toEqual(['a'])
  })

  it('handles scoped names and messy tag histories', () => {
    const set = deriveReleaseSet(
      [ws('@nuxt/kit', '5.0.0'), ws('fontaine', '0.8.0')],
      ['fontaine@0.8.0', '@nuxt/kit@4.9.0', 'v0.6.0', '0.2.3'],
    )
    expect(set).toEqual([{ name: '@nuxt/kit', version: '5.0.0', dir: 'packages/kit' }])
  })

  it('returns releases with dependencies before their dependents', () => {
    const set = deriveReleaseSet(
      [
        ws('app', '1.0.1', { dependencies: { kit: 'workspace:*' } }),
        ws('kit', '2.1.0'),
      ],
      ['app@1.0.0', 'kit@2.0.0'],
    )
    expect(set.map(r => r.name)).toEqual(['kit', 'app'])
  })

  // Depends on `latestTagForPackage` selecting the highest version among
  // matches, not the first in creation-date order: a retag or backported
  // patch release can make an older version's tag newer than the latest.
  it('excludes an already-tagged version even when tag creation order contradicts version order', () => {
    const set = deriveReleaseSet(
      [ws('fontaine', '0.8.1'), ws('fontless', '0.2.1')],
      ['fontless@0.2.1', 'fontaine@0.8.0', 'fontaine@0.8.1'],
    )
    expect(set).toEqual([])
  })

  it('rejects non-semver workspace versions', () => {
    expect(() => deriveReleaseSet([ws('a', 'not-a-version')], [])).toThrow(/non-semver/)
  })
})

describe('tag names', () => {
  it('builds per-package tags including scoped names', () => {
    expect(packageTag({ name: '@nuxt/kit', version: '5.0.0' })).toBe('@nuxt/kit@5.0.0')
    expect(packageTag({ name: 'fontaine', version: '0.8.0' })).toBe('fontaine@0.8.0')
  })

  it('builds the coordination tag from the UTC date', () => {
    const tag = coordinationTag(new Date('2026-02-03T23:59:00Z'))
    expect(tag).toBe('release-2026-02-03')
    expect(tag).toMatch(COORDINATION_TAG_RE)
  })

  it('increments the coordination tag for later releases the same day', () => {
    const taken = new Set(['release-2026-02-03', 'release-2026-02-03.2'])
    const tag = coordinationTag(new Date('2026-02-03T23:59:00Z'), t => taken.has(t))
    expect(tag).toBe('release-2026-02-03.3')
    expect(tag).toMatch(COORDINATION_TAG_RE)
  })

  it('gives up rather than looping forever on a saturated day', () => {
    expect(() => coordinationTag(new Date('2026-02-03T00:00:00Z'), () => true)).toThrow(/free coordination tag/)
  })

  it('titles the release with the packages it covers', () => {
    expect(releaseTitle([{ name: 'fontaine', version: '0.9.0', dir: '.' }])).toBe('fontaine@0.9.0')
    expect(releaseTitle([
      { name: 'a', version: '1.0.0', dir: 'a' },
      { name: 'b', version: '2.0.0', dir: 'b' },
      { name: 'c', version: '3.0.0', dir: 'c' },
      { name: 'd', version: '4.0.0', dir: 'd' },
    ])).toBe('a@1.0.0, b@2.0.0, c@3.0.0 and 1 more')
    expect(releaseTitle([], new Date('2026-02-03T00:00:00Z'))).toBe('2026-02-03')
  })
})

describe('releases payload', () => {
  const entries = [
    { name: '@nuxt/kit', version: '5.0.0', dir: 'packages/kit' },
    { name: 'nuxt', version: '4.2.0', dir: 'packages/nuxt' },
  ]

  it('round-trips through serialise/parse preserving order', () => {
    expect(releasesFromEnv(serialiseReleases(entries))).toEqual(entries)
  })

  it('returns null when absent or blank', () => {
    expect(releasesFromEnv(undefined)).toBeNull()
    expect(releasesFromEnv('')).toBeNull()
    expect(releasesFromEnv('  \n')).toBeNull()
  })

  it('rejects malformed payloads with a clear error', () => {
    expect(() => releasesFromEnv('not json')).toThrow(/not valid JSON/)
    expect(() => releasesFromEnv('{}')).toThrow(/non-empty JSON array/)
    expect(() => releasesFromEnv('[]')).toThrow(/non-empty JSON array/)
    expect(() => releasesFromEnv('["a@1.0.0"]')).toThrow(/not an object/)
    expect(() => releasesFromEnv('[{"name":"--flag","version":"1.0.0","dir":"a"}]')).toThrow(/invalid package name/)
    expect(() => releasesFromEnv('[{"name":"a","version":"latest","dir":"a"}]')).toThrow(/non-semver version/)
    expect(() => releasesFromEnv('[{"name":"a","version":"1.0.0","dir":"../a"}]')).toThrow(/unsafe dir/)
    expect(() => releasesFromEnv('[{"name":"a","version":"1.0.0","dir":"/a"}]')).toThrow(/unsafe dir/)
    expect(() => releasesFromEnv('[{"name":"a","version":"1.0.0"}]')).toThrow(/unsafe dir/)
    expect(() => releasesFromEnv(JSON.stringify([entries[0], entries[0]])))
      .toThrow(/more than once/)
  })
})

describe('expectedTarballName', () => {
  it('matches npm pack filenames for plain and scoped names', () => {
    expect(expectedTarballName('fontaine', '0.8.0')).toBe('fontaine-0.8.0.tgz')
    expect(expectedTarballName('@nuxt/kit', '5.0.0')).toBe('nuxt-kit-5.0.0.tgz')
  })
})
