// Workspace resolution for the lockstep monorepo path.
//
// The maintainer declares the publishable workspaces in the workflow
// file via the `packages` input on `uppt/pr` and `uppt/pack`. Each line
// is either a literal directory path or a glob (e.g. `packages/*`).
// Negated patterns (`!packages/playground`) are supported.

import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

export interface Workspace {
  /** Absolute path to the workspace directory. */
  dir: string
  /** Path relative to the monorepo root, using forward slashes. */
  relDir: string
  /** Value of `name` in the workspace `package.json`. */
  name: string
  /** Value of `version` in the workspace `package.json`, or `null` if absent. */
  version: string | null
  /** Parsed contents of the workspace `package.json`. */
  pkg: Record<string, unknown>
}

interface RawPackageJson {
  name?: string
  version?: string
  private?: boolean
  [key: string]: unknown
}

/**
 * Parse a newline-separated `packages:` input. Blank lines and `#`
 * comments are stripped; everything else is treated as a glob or
 * literal path, with `!`-prefixed entries acting as excludes.
 */
export function parsePackagesInput (raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

/**
 * Expand a list of glob patterns rooted at `rootDir` into directories
 * that contain a `package.json`. Patterns starting with `!` are
 * treated as exclusions.
 *
 * Literal (non-glob) patterns are required to match a real workspace
 * directory: a typo like `packages/aa` in an otherwise-valid list would
 * otherwise be silently dropped. Glob patterns are allowed to match
 * nothing on their own; the aggregate "matched no directories" check in
 * `resolveWorkspaces` covers the case where every pattern misses.
 */
export function expandPackagePatterns (rootDir: string, patterns: string[]): string[] {
  const positive: string[] = []
  const negative: string[] = []
  for (const p of patterns) {
    if (p.startsWith('!')) negative.push(p.slice(1))
    else positive.push(p)
  }
  if (!positive.length) return []

  const matched = new Set<string>()
  for (const pattern of positive) {
    let hit = false
    for (const match of globSync(pattern, { cwd: rootDir })) {
      const abs = resolve(rootDir, match)
      if (!isDirectoryWithPackageJson(abs)) continue
      matched.add(abs)
      hit = true
    }
    if (!hit && !isGlob(pattern)) {
      throw new Error(
        `\`packages\` entry "${pattern}" did not match a directory with a package.json. Fix the path or remove the entry.`,
      )
    }
  }
  for (const pattern of negative) {
    for (const match of globSync(pattern, { cwd: rootDir })) {
      matched.delete(resolve(rootDir, match))
    }
  }
  return [...matched].sort()
}

function isGlob (pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern)
}

function isDirectoryWithPackageJson (dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  return existsSync(resolve(dir, 'package.json'))
}

/**
 * Resolve the maintainer-declared `packages` input into concrete
 * `Workspace` records. Any matched directory whose `package.json`
 * is `"private": true` is silently dropped.
 *
 * Throws if any matched directory is missing a `name` field, or if
 * the input is empty, or if no patterns matched anything.
 */
export function resolveWorkspaces (rootDir: string, packagesInput: string): Workspace[] {
  const patterns = parsePackagesInput(packagesInput)
  if (!patterns.length) {
    throw new Error('`packages` input is empty: provide one path or glob per line.')
  }

  const dirs = expandPackagePatterns(rootDir, patterns)
  if (!dirs.length) {
    throw new Error(
      `\`packages\` input matched no directories with a package.json.\nPatterns:\n${patterns.map(p => `  - ${p}`).join('\n')}`,
    )
  }

  const workspaces: Workspace[] = []
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as RawPackageJson
    if (pkg.private === true) continue
    if (!pkg.name) {
      throw new Error(`Workspace at ${relative(rootDir, dir) || '.'} has no "name" field in package.json.`)
    }
    workspaces.push({
      dir,
      relDir: relative(rootDir, dir).split(sep).join('/') || '.',
      name: pkg.name,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      pkg,
    })
  }
  return workspaces
}

/**
 * Resolve the current lockstep version for a monorepo from its
 * workspaces. Workspaces are the source of truth: if they all agree on
 * a single semver version, that's the lockstep version. Anything else
 * is an error.
 *
 * The root `package.json#version` and the latest tag are deliberately
 * *not* consulted here. The root may legitimately be at `0.0.0` or
 * have no version at all; the tag may have drifted from the workspaces
 * via a manual publish. Trusting either over the workspaces produces
 * surprising releases.
 */
export function lockstepVersionFromWorkspaces (workspaces: Workspace[]): string {
  const allVersions = workspaces.map(ws => ws.version)
  if (allVersions.every(v => v === null)) {
    throw new Error(
      'No listed workspace has a `version` field. Lockstep releases need every workspace to share a single semver version.',
    )
  }

  const distinct = new Set(allVersions.map(v => (v !== null && isSemver(v)) ? v : null))
  if (distinct.size === 1 && !distinct.has(null)) {
    return [...distinct][0]!
  }

  const detail = workspaces
    .map(ws => `  - ${ws.name}: ${ws.version ?? '<missing>'}`)
    .join('\n')
  throw new Error(
    'Workspaces do not agree on a single version. uppt currently supports lockstep releases only: '
    + 'every listed package must share the same semver version. Reconcile them before releasing.\n'
    + detail,
  )
}

export function isSemver (value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)
}
