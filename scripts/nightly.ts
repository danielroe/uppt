// Rewrite package.json(s) into nightly builds before `uppt/pack` packs
// them: `<name><suffix>@<version>-<YYMMDDHHmm>-<sha7>`, with dependencies
// between listed packages pinned to the nightlies from the same commit.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isValidPackageName } from './_independent.ts'
import { resolveWorkspaces } from './_workspaces.ts'
import { makePkgFormatter } from './pkg-format.ts'

const ALL_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
const ALIAS_FIELDS = ['dependencies', 'optionalDependencies'] as const

const DEFAULT_SUFFIX = '-nightly'

export function nightlyTimestamp (date: Date): string {
  return date.toISOString().replace(/\D/g, '').slice(2, 12)
}

export function nightlyVersion (version: string, date: Date, sha: string): string {
  const core = version.match(/^\d+\.\d+\.\d+/)?.[0]
  if (!core) throw new Error(`Invalid version: ${JSON.stringify(version)}`)
  if (!/^[0-9a-f]{7,}$/.test(sha)) {
    throw new Error(`Invalid commit sha: ${JSON.stringify(sha)}`)
  }
  return `${core}-${nightlyTimestamp(date)}-${sha.slice(0, 7)}`
}

export function validateSuffix (suffix: string): string {
  if (!/^[a-z0-9._-]+$/.test(suffix)) {
    throw new Error(`Invalid nightly suffix ${JSON.stringify(suffix)}: expected lowercase alphanumerics, ".", "_" or "-".`)
  }
  return suffix
}

export function nightlyName (name: string, suffix: string): string {
  const renamed = `${name}${suffix}`
  if (!isValidPackageName(renamed)) {
    throw new Error(`Nightly package name ${JSON.stringify(renamed)} is not a valid npm package name.`)
  }
  return renamed
}

/** Lines of `<name>` or `<name>: <target>[@<range>]`, mapped to `npm:` specifiers. */
export function parseAliases (raw: string, suffix: string): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const line of raw.split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean)) {
    const match = line.match(/^(@?[^@:\s]+)(?:\s*:\s*(@?[^@:\s]+)(?:@([^@:\s]+))?)?$/)
    if (!match) throw new Error(`Invalid alias line: ${JSON.stringify(line)}`)
    const [, name, target = nightlyName(name!, suffix), range = 'latest'] = match
    if (!isValidPackageName(name!) || !isValidPackageName(target)) {
      throw new Error(`Invalid package name in alias line: ${JSON.stringify(line)}`)
    }
    aliases.set(name!, `npm:${target}@${range}`)
  }
  return aliases
}

function unscoped (name: string): string {
  return name.replace(/^@[^/]+\//, '')
}

// `npx <pkg>` only picks a bin matching the unscoped package name when there are several.
export function nightlyBin (bin: unknown, name: string, renamed: string, suffix: string): Record<string, string> | undefined {
  if (typeof bin === 'string') bin = { [unscoped(name)]: bin }
  if (!bin || typeof bin !== 'object') return undefined
  const entries = Object.entries(bin as Record<string, string>)
  if (!entries.length) return undefined
  const out: Record<string, string> = { ...(bin as Record<string, string>) }
  for (const [command, path] of entries) out[`${command}${suffix}`] ??= path
  out[unscoped(renamed)] ??= entries[0]![1]
  return out
}

export interface NightlyTarget {
  name: string
  version: string
}

export function rewriteManifest (
  pkg: Record<string, unknown>,
  opts: { suffix: string, targets: Map<string, NightlyTarget>, aliases: Map<string, string> },
): void {
  const name = pkg.name as string
  const self = opts.targets.get(name)!
  pkg.name = self.name
  pkg.version = self.version
  const bin = nightlyBin(pkg.bin, name, self.name, opts.suffix)
  if (bin) pkg.bin = bin

  for (const field of ALL_DEPENDENCY_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined
    if (!deps || typeof deps !== 'object') continue
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('npm:')) continue
      const target = opts.targets.get(dep)
      if (target) {
        deps[dep] = `npm:${target.name}@${target.version}`
      }
      else if ((ALIAS_FIELDS as readonly string[]).includes(field) && opts.aliases.has(dep)) {
        deps[dep] = opts.aliases.get(dep)!
      }
    }
  }
}

function git (...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

export function applyNightly (rootDir: string, opts: { packagesInput: string, suffix?: string, aliases?: string }): NightlyTarget[] {
  const suffix = validateSuffix(opts.suffix || DEFAULT_SUFFIX)
  const aliases = parseAliases(opts.aliases ?? '', suffix)

  const dirs = opts.packagesInput
    ? resolveWorkspaces(rootDir, opts.packagesInput).map(ws => ws.dir)
    : [rootDir]
  const manifests = dirs.map((dir) => {
    const path = resolve(dir, 'package.json')
    const source = readFileSync(path, 'utf8')
    return { path, source, pkg: JSON.parse(source) as Record<string, unknown> }
  })

  const [sha, epoch] = git('log', '-1', '--format=%H %ct', 'HEAD').split(' ')
  const date = new Date(Number(epoch) * 1000)

  const targets = new Map<string, NightlyTarget>()
  for (const { pkg } of manifests) {
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
      throw new Error(`Nightly builds need a "name" and "version" in every package.json (got ${JSON.stringify(pkg.name)}@${JSON.stringify(pkg.version)}).`)
    }
    if (pkg.private === true) {
      throw new Error(`Refusing to publish a nightly of private package ${pkg.name}.`)
    }
    targets.set(pkg.name, {
      name: nightlyName(pkg.name, suffix),
      version: nightlyVersion(pkg.version, date, sha!),
    })
  }

  for (const { path, source, pkg } of manifests) {
    rewriteManifest(pkg, { suffix, targets, aliases })
    writeFileSync(path, makePkgFormatter(source)(pkg))
  }

  const result = [...targets.values()]
  for (const target of result) console.log(`Nightly: ${target.name}@${target.version}`)
  return result
}
