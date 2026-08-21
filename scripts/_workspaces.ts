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
  /** Raw on-disk contents of the workspace `package.json`, preserved so writes can match the original indentation and line endings. */
  source: string
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
    const source = readFileSync(resolve(dir, 'package.json'), 'utf8')
    const pkg = JSON.parse(source) as RawPackageJson
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
      source,
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
    'Workspaces do not agree on a single version, which lockstep mode requires. '
    + 'Reconcile them to a single version, or set `mode: independent` to version each package on its own cadence.\n'
    + detail,
  )
}

export function isSemver (value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)
}

/**
 * Resolve the version uppt should act on, the single place both `uppt/pr`
 * (bump source) and `uppt/release` (tag source) agree on so they can never
 * drift apart.
 */
export function resolveCurrentVersion (rootDir: string, packagesInput: string): string {
  if (packagesInput.length > 0) {
    return lockstepVersionFromWorkspaces(resolveWorkspaces(rootDir, packagesInput))
  }

  const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as RawPackageJson
  if (pkg.version === '0.0.0' && pkg.private === true) {
    throw new Error('Refusing to act on a private root package.json pinned to 0.0.0. This looks like a monorepo: pass the same `packages` input that `uppt/pr` uses.')
  }
  if (typeof pkg.version !== 'string') {
    throw new Error('Cannot determine version: root package.json has no `version` field. Set one, or pass the `packages` input to release a monorepo.')
  }
  return pkg.version
}

/**
 * Parse a newline-separated `scopes:` input into a map of package name
 * → declared commit scopes. Each non-blank, non-comment line takes the
 * shape `<package-name>: <scope> [<scope> ...]`. Whitespace is
 * flexible; comments start with `#`.
 *
 * Used by `buildScopeMap` to override the default basename-derived
 * scope for any package the maintainer wants to disambiguate or alias.
 */
export function parseScopesInput (raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/#.*$/, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon === -1) {
      throw new Error(`\`scopes\` entry on line ${i + 1} is missing a colon. Expected "<package-name>: <scope> [<scope> ...]", got "${line}".`)
    }
    const name = line.slice(0, colon).trim()
    if (!name) {
      throw new Error(`\`scopes\` entry on line ${i + 1} has an empty package name.`)
    }
    const scopes = line.slice(colon + 1).split(/\s+/).filter(Boolean)
    if (!scopes.length) {
      throw new Error(`\`scopes\` entry for "${name}" lists no scopes. Drop the line or add at least one scope.`)
    }
    if (out.has(name)) {
      throw new Error(`\`scopes\` entry for "${name}" appears more than once. Combine the scopes onto a single line.`)
    }
    out.set(name, scopes)
  }
  return out
}

/**
 * Inverse view of the workspace→scopes mapping: given a commit scope,
 * return the workspaces that own it. Built once per release run.
 */
export interface ScopeMap {
  /** Resolve a commit scope to the workspace that owns it, or `null`. */
  resolve (scope: string): Workspace | null
  /** Every (workspace, declared scopes) pair, in the input workspace order. */
  entries (): Array<{ workspace: Workspace, scopes: string[] }>
}

/**
 * Build the bidirectional scope routing map. For each workspace, the
 * declared scopes come from `overrides` if present, otherwise from
 * the basename of the package name (`@nuxt/kit` -> `kit`, `nuxt` ->
 * `nuxt`).
 *
 * Throws when:
 *   - an override references a package not in `workspaces` (likely a
 *     stale entry from a rename);
 *   - two workspaces end up claiming the same scope (routing would be
 *     ambiguous; the maintainer must disambiguate with overrides).
 */
export function buildScopeMap (
  workspaces: Workspace[],
  overrides: Map<string, string[]>,
): ScopeMap {
  const byName = new Map(workspaces.map(ws => [ws.name, ws]))

  for (const name of overrides.keys()) {
    if (!byName.has(name)) {
      throw new Error(
        `\`scopes\` entry references "${name}", which is not in the resolved \`packages\` list. `
        + 'Remove the entry or add the package to `packages`.',
      )
    }
  }

  const perWorkspace: Array<{ workspace: Workspace, scopes: string[] }> = []
  const inverse = new Map<string, Workspace>()

  for (const ws of workspaces) {
    const scopes = overrides.get(ws.name) ?? [defaultScopeForName(ws.name)]
    perWorkspace.push({ workspace: ws, scopes })
    for (const scope of scopes) {
      const existing = inverse.get(scope)
      if (existing && existing !== ws) {
        throw new Error(
          `Commit scope "${scope}" is claimed by both "${existing.name}" and "${ws.name}". `
          + 'Disambiguate via the `scopes` input.',
        )
      }
      inverse.set(scope, ws)
    }
  }

  return {
    resolve: scope => inverse.get(scope) ?? null,
    entries: () => perWorkspace,
  }
}

function defaultScopeForName (name: string): string {
  // `@nuxt/kit` -> `kit`; `nuxt` -> `nuxt`; `@scope/foo/bar` -> `bar`
  // (unlikely shape but handle it without crashing).
  const slash = name.lastIndexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}
