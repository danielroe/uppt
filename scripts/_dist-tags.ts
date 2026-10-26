// dist-tag helpers shared by `publish.ts` and `dist-tag.ts`. The first
// tag of the `npm-tag` list is the publish tag; the rest are applied
// with `npm dist-tag add` once the version is live.

import { execFileSync } from 'node:child_process'
import { isValidPackageName } from './_independent.ts'
import { compareSemver, isSemver } from './_workspaces.ts'

const DIST_TAG_RE = /^[a-z0-9][\w.-]*$/i

/** A published (or staged) version and the extra dist-tags to point at it. */
export interface DistTagEntry {
  name: string
  version: string
  tags: string[]
}

/**
 * Parse a whitespace- or comma-separated list of dist-tags, dropping
 * duplicates and keeping the order.
 *
 * @param label how to name the input in error messages
 */
export function parseDistTags (raw: string | undefined, label: string): string[] {
  const tags = [...new Set((raw ?? '').split(/[\s,]+/).filter(Boolean))]
  for (const tag of tags) {
    if (!DIST_TAG_RE.test(tag) || isSemver(tag)) {
      throw new Error(`${label} is not a valid dist-tag: ${JSON.stringify(tag)}`)
    }
  }
  return tags
}

/** Parse and validate the JSON array of {@link DistTagEntry} emitted by `uppt/publish`. */
export function parseDistTagEntries (raw: string | undefined): DistTagEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw?.trim() || '[]')
  }
  catch (err) {
    throw new Error(`DIST_TAGS is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) throw new Error('DIST_TAGS must be a JSON array')
  return parsed.map((entry: Partial<DistTagEntry> | null) => {
    if (!entry || typeof entry.name !== 'string' || !isValidPackageName(entry.name)
      || typeof entry.version !== 'string' || !isSemver(entry.version)
      || !Array.isArray(entry.tags) || !entry.tags.length || !entry.tags.every(tag => typeof tag === 'string')) {
      throw new Error(`DIST_TAGS contains an invalid entry: ${JSON.stringify(entry)}`)
    }
    return { name: entry.name, version: entry.version, tags: parseDistTags(entry.tags.join(' '), 'DIST_TAGS') }
  })
}

/** Name and version from the `package.json` inside an `npm pack` tarball. */
export function tarballManifest (tarballPath: string): { name: string, version: string } {
  const raw = execFileSync('tar', ['-xzOf', tarballPath, 'package/package.json'], { encoding: 'utf8' })
  const { name, version } = JSON.parse(raw) as { name?: unknown, version?: unknown }
  if (typeof name !== 'string' || !isValidPackageName(name) || typeof version !== 'string' || !isSemver(version)) {
    throw new Error(`Tarball ${tarballPath} has an invalid name or version: ${JSON.stringify({ name, version })}`)
  }
  return { name, version }
}

function currentDistTags (name: string): Map<string, string> {
  const stdout = execFileSync('npm', ['dist-tag', 'ls', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const tags = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^([^:\s]+): (\S+)$/)
    if (match) tags.set(match[1]!, match[2]!)
  }
  return tags
}

/**
 * Point each of `tags` at `name@version`, skipping any tag that already
 * points at the same or a newer version.
 */
export function addDistTags ({ name, version, tags }: DistTagEntry): void {
  const current = currentDistTags(name)
  for (const tag of tags) {
    const existing = current.get(tag)
    if (existing && isSemver(existing) && compareSemver(existing, version) >= 0) {
      console.log(`${name}@${tag} is already ${existing}; leaving it in place of ${version}.`)
      continue
    }
    const args = ['dist-tag', 'add', `${name}@${version}`, tag]
    console.log('$ npm', ...args)
    execFileSync('npm', args, { stdio: 'inherit' })
  }
}
