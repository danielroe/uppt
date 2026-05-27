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
}

interface RawPackageJson {
  name?: string
  version?: string
  private?: boolean
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
    for (const match of globSync(pattern, { cwd: rootDir })) {
      const abs = resolve(rootDir, match)
      if (!isDirectoryWithPackageJson(abs)) continue
      matched.add(abs)
    }
  }
  for (const pattern of negative) {
    for (const match of globSync(pattern, { cwd: rootDir })) {
      matched.delete(resolve(rootDir, match))
    }
  }
  return [...matched].sort()
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
    })
  }
  return workspaces
}

/**
 * Resolve the current lockstep version for the repo. We try, in order:
 *
 *   1. The version implied by the latest semver-shaped tag, if one was
 *      passed in. Tags are the source of truth for "what is published".
 *   2. The root `package.json#version`, if it exists and is semver. This
 *      covers single-package repos where the private root carries the
 *      canonical version.
 *   3. The single version shared by every declared workspace, if they
 *      all agree.
 *
 * Throws when workspaces disagree on version, because that almost
 * always means a half-finished manual bump, and silently picking one
 * would produce a wrong release.
 */
export function resolveCurrentLockstepVersion (
  rootDir: string,
  latestTagName: string | null,
  workspaces: Workspace[],
): string {
  if (latestTagName) {
    const fromTag = latestTagName.replace(/^v/, '')
    if (isSemver(fromTag)) return fromTag
  }

  const rootPkgPath = resolve(rootDir, 'package.json')
  if (existsSync(rootPkgPath)) {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as { version?: string }
    if (typeof rootPkg.version === 'string' && isSemver(rootPkg.version)) {
      return rootPkg.version
    }
  }

  const versioned = workspaces.filter(ws => ws.version !== null)
  if (versioned.length) {
    const versions = new Set(versioned.map(ws => ws.version!))
    if (versions.size === 1) return [...versions][0]!
    const detail = versioned
      .map(ws => `  - ${ws.name}: ${ws.version}`)
      .join('\n')
    throw new Error(
      'Cannot determine current lockstep version: workspaces disagree.\n'
      + 'Reconcile them to a single version (or set a `version` on the root package.json) before releasing.\n'
      + detail,
    )
  }

  throw new Error(
    'Cannot determine current lockstep version: no tag, no root version, no workspace with a version.',
  )
}

export function isSemver (value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)
}
