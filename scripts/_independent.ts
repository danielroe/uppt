// Independent-versioning release helpers shared by `tag-and-release.ts`
// (derive the release set and fan out tags), `pack.ts` (pack exactly the
// dispatched packages) and `publish.ts` (stage them).
//
// The release set is derived from the checked-out tree, never from the
// PR body: each workspace's `package.json` version is compared against
// the version it was last released at, so maintainer-editable markdown
// can never decide what gets published.

import { isSemver, type Workspace } from './_workspaces.ts'
import { buildDependencyGraph, topologicalOrder } from './_dependency-graph.ts'
import { latestLockstepTag, latestTagForPackage } from './update-changelog.ts'

/**
 * One entry of the `releases` dispatch payload. The array is the
 * contract between `uppt/release` and `uppt/pack` / `uppt/publish`:
 * one entry per released package.
 */
export interface ReleaseEntry {
  /** Package name as declared in its `package.json` (e.g. `@nuxt/kit`). */
  name: string
  /** Strict semver version being released. */
  version: string
  /** Workspace directory relative to the repo root, forward slashes. */
  dir: string
}

// npm's own naming rule, minus legacy uppercase names. Doubles as an
// argv/ref-injection guard: no leading `-`, no whitespace, no `..`.
const PACKAGE_NAME_RE = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/

export function isValidPackageName (name: string): boolean {
  return PACKAGE_NAME_RE.test(name)
}

function isSafeRelDir (dir: string): boolean {
  if (dir === '.') return true
  if (!dir.length || dir.startsWith('/') || dir.includes('\\')) return false
  return dir.split('/').every(seg => /^[\w.-]+$/.test(seg) && seg !== '.' && seg !== '..')
}

/**
 * Derive the set of packages being released at the current commit:
 * every workspace whose `package.json` version differs from the version
 * it was last released at.
 *
 * A package's last release is its newest `<name>@X.Y.Z` tag, falling
 * back to the newest lockstep `vX.Y.Z` tag. Without that fallback the
 * first independent release after a lockstep history would re-release
 * every package at its current, already-published version.
 */
export function deriveReleaseSet (workspaces: Workspace[], tags: string[]): ReleaseEntry[] {
  const byName = new Map(workspaces.map(ws => [ws.name, ws]))
  const order = topologicalOrder(buildDependencyGraph(workspaces))
  const lockstepTag = latestLockstepTag(tags)

  const releases: ReleaseEntry[] = []
  for (const name of order) {
    const ws = byName.get(name)!
    if (ws.version === null) continue
    if (!isSemver(ws.version)) {
      throw new Error(`Workspace ${name} has non-semver version "${ws.version}"; refusing to derive a release set.`)
    }
    const tag = latestTagForPackage(name, tags)
    const releasedVersion = tag
      ? tag.name.slice(name.length + 1)
      : lockstepTag?.name.slice(1) ?? null
    if (releasedVersion === ws.version) continue
    releases.push({ name, version: ws.version, dir: ws.relDir })
  }
  return releases
}

/** Per-package git tag name: `<name>@X.Y.Z`. */
export function packageTag (entry: Pick<ReleaseEntry, 'name' | 'version'>): string {
  return `${entry.name}@${entry.version}`
}

export const COORDINATION_TAG_RE = /^release-\d{4}-\d{2}-\d{2}-[0-9a-f]{7,40}$/

/**
 * Release-bearing tag for an independent merge: `release-YYYY-MM-DD-<short-sha>`
 * (UTC date). The GitHub release attaches here so no single package's tag
 * is privileged as "the" release.
 */
export function coordinationTag (sha: string, date: Date = new Date()): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Expected a full commit sha, got "${sha}"`)
  }
  return `release-${date.toISOString().slice(0, 10)}-${sha.slice(0, 7)}`
}

export function serialiseReleases (releases: ReleaseEntry[]): string {
  return JSON.stringify(releases)
}

/**
 * Parse the `releases` env plumbed from the workflow_dispatch input.
 * Returns `null` when absent or blank (lockstep / single-package mode);
 * throws on anything malformed rather than silently ignoring it.
 */
export function releasesFromEnv (raw: string | undefined): ReleaseEntry[] | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  }
  catch (err) {
    throw new Error(`RELEASES is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('RELEASES must be a non-empty JSON array of { name, version, dir } entries')
  }
  const releases: ReleaseEntry[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`RELEASES entry is not an object: ${JSON.stringify(entry)}`)
    }
    const { name, version, dir } = entry as Record<string, unknown>
    if (typeof name !== 'string' || !isValidPackageName(name)) {
      throw new Error(`RELEASES entry has an invalid package name: ${JSON.stringify(name)}`)
    }
    if (typeof version !== 'string' || !isSemver(version)) {
      throw new Error(`RELEASES entry for ${name} has a non-semver version: ${JSON.stringify(version)}`)
    }
    if (typeof dir !== 'string' || !isSafeRelDir(dir)) {
      throw new Error(`RELEASES entry for ${name} has an unsafe dir: ${JSON.stringify(dir)}`)
    }
    if (seen.has(name)) {
      throw new Error(`RELEASES lists ${name} more than once`)
    }
    seen.add(name)
    releases.push({ name, version, dir })
  }
  return releases
}

/**
 * Tarball filename `npm pack` / `pnpm pack` produce for a package
 * (`@nuxt/kit@5.0.0` → `nuxt-kit-5.0.0.tgz`).
 */
export function expectedTarballName (name: string, version: string): string {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}
