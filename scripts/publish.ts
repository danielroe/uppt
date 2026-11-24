// Stage-publish prebuilt tarball(s) to npm using OIDC trusted
// publishing. The maintainer approves the staged version with 2FA on
// npmjs.com afterwards.
//
// The tarball(s) were produced by `uppt/pack` in an earlier job in the
// same workflow run and downloaded into `TARBALL_DIR` by
// `actions/download-artifact`. When `TARBALL_FILES` is set (a JSON
// array of filenames, emitted by `uppt/pack` as a step output), we
// publish exactly those, in order. Otherwise we fall back to scanning
// `TARBALL_DIR` for `*.tgz`.
//
// `npm publish <tarball>` doesn't run lifecycle scripts in any case
// (the tarball is treated as an opaque artifact), but we still pass
// `--ignore-scripts` for clarity.
//
// npm refuses to stage a prerelease version without an explicit
// `--tag`, and would otherwise move `latest` to it, so the dist-tag is
// derived from each tarball's version: stable versions publish to
// `latest`, `X.Y.Z-beta.N` to `beta`, and a prerelease with no name to
// use (`X.Y.Z-0`) to `next`. `NPM_TAG` overrides the derivation for
// every tarball, and is required when a tarball's filename carries no
// parseable version.
//
// `NPM_TAG` may list several tags. The first is the publish tag; the
// rest are added with `npm dist-tag add` straight after a nightly
// publish, or written to the `dist-tags` output for `uppt/dist-tag` to
// apply once a staged version has been approved.
//
// Staging is re-runnable: every tarball is attempted, a version that npm
// reports as already staged (or already published) is skipped rather than
// failing the run, and the step ends with a summary of what was staged,
// skipped and failed.
//
// Env:
//   NPM_ACCESS      `public` (default) or `restricted`
//   NPM_TAG         optional dist-tag override for every tarball; a
//                   whitespace- or comma-separated list adds the
//                   remaining tags alongside the first
//   GITHUB_OUTPUT   set by the runner; receives `dist-tags=<json>`
//   TARBALL_DIR     directory holding the prebuilt `*.tgz` files
//   TARBALL_FILES   optional JSON array of filenames within TARBALL_DIR
//   RELEASES        optional JSON payload emitted by `uppt/release` in
//                   independent mode: an array of
//                   `{ name, version, dir }`. Names the tarballs to
//                   stage when TARBALL_FILES is absent.
//   NIGHTLY         `true` to `npm publish` nightlies (dist-tag
//                   `latest` by default) instead of staging

import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runMain } from './_cli.ts'
import { addDistTags, parseDistTags, tarballManifest, type DistTagEntry } from './_dist-tags.ts'
import { expectedTarballName, releasesFromEnv } from './_independent.ts'

function runTolerating403 (cmd: string, args: string[]) {
  console.log('$', cmd, ...args)
  const result = spawnSync(cmd, args, { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8' })
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status === 0) return
  if (/\bE403\b/.test(result.stderr)) {
    console.log(`::warning::npm ${args[0]} of ${args[1]} returned E403; skipping it (is this version already published?).`)
    return
  }
  throw new Error(`Command failed: ${cmd} ${args.join(' ')} (exit ${result.status ?? result.signal})`)
}

type StageOutcome =
  | { status: 'staged' }
  | { status: 'skipped', detail: string }

function npmSilently (args: string[]) {
  const result = spawnSync('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function npmErrorCode (stderr: string): string | undefined {
  return /npm error code (E[A-Z0-9]+)/.exec(stderr)?.[1]
}

function tarballDigests (tarballPath: string) {
  const contents = readFileSync(tarballPath)
  return {
    shasum: createHash('sha1').update(contents).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(contents).digest('base64')}`,
  }
}

function publishedDist (name: string, version: string) {
  const { status, stdout, stderr } = npmSilently(['view', `${name}@${version}`, 'dist.integrity', 'dist.shasum', '--json'])
  if (status === 0) {
    try {
      const parsed = JSON.parse(stdout) as { 'dist.integrity'?: string, 'dist.shasum'?: string }
      return { integrity: parsed['dist.integrity'], shasum: parsed['dist.shasum'] }
    }
    catch {
      return null
    }
  }
  const code = npmErrorCode(stderr)
  if (code === 'E404') return null
  throw new Error(`Could not check whether ${name}@${version} is already published.${code ? ` npm view reported ${code}.` : ''}`)
}

const PENDING_STAGE_STATUSES = new Set(['staged', 'validating', 'awaiting_approval'])

interface StagedEntry {
  id: string | undefined
  shasum: string | undefined
}

type StagedLookup =
  | { state: 'found', entries: StagedEntry[] }
  | { state: 'absent' }
  | { state: 'unavailable' }

interface StagedItem {
  id?: string
  packageName?: string
  version?: string
  shasum?: string
  status?: string
}

function stagedVersion (name: string, version: string): StagedLookup {
  const { status, stdout } = npmSilently(['stage', 'list', name, '--json'])
  if (status !== 0) return { state: 'unavailable' }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  }
  catch {
    return { state: 'unavailable' }
  }
  if (!Array.isArray(parsed)) return { state: 'unavailable' }
  const entries = (parsed as StagedItem[])
    .filter(item => item.packageName === name && item.version === version)
    .filter(item => item.status === undefined || PENDING_STAGE_STATUSES.has(item.status))
    .map(({ id, shasum }) => ({ id, shasum }))
  if (!entries.length) return { state: 'absent' }
  return { state: 'found', entries }
}

function formatIds (entries: StagedEntry[]): string {
  const ids = entries.map(({ id }) => id).filter((id): id is string => id !== undefined)
  return ids.length ? ids.join(', ') : 'npm reported no id'
}

const STAGE_CONFLICT_TEXT = /Cannot stage previously published version/

function resolveStageConflict (tarballPath: string, { name, version }: { name: string, version: string }, stderr: string): StageOutcome {
  const local = tarballDigests(tarballPath)
  const published = publishedDist(name, version)
  if (published) {
    const same = published.integrity ? published.integrity === local.integrity : published.shasum === local.shasum
    if (same) return { status: 'skipped', detail: `${name}@${version} is already published` }
    throw new Error(`${name}@${version} is already published with different contents: the registry has ${published.integrity ?? published.shasum}, this run's tarball is ${local.integrity}.`)
  }
  const staged = stagedVersion(name, version)
  if (staged.state === 'found') {
    if (staged.entries.some(entry => entry.shasum !== undefined && entry.shasum === local.shasum)) {
      return { status: 'skipped', detail: `${name}@${version} is already staged` }
    }
    const ids = formatIds(staged.entries)
    if (staged.entries.every(entry => entry.shasum === undefined)) {
      const unverified = `${name}@${version} is already staged (${ids}), but npm reported no shasum for it, so this run could not check that the staged tarball matches.`
      if (!STAGE_CONFLICT_TEXT.test(stderr)) {
        throw new Error(`${unverified} npm's error was not the expected conflict, so check \`npm stage list ${name}\` and re-run this job.`)
      }
      console.log(`::warning::${unverified} Review it with \`npm stage list ${name}\` before approving.`)
      return { status: 'skipped', detail: `${name}@${version} is already staged, contents unverified` }
    }
    throw new Error(`${name}@${version} is already staged (${ids}) with different contents. Reject each staged copy with \`npm stage reject <id>\`, then re-run this job.`)
  }
  if (staged.state === 'absent') {
    throw new Error(`npm reported a conflict staging ${name}@${version}, but that version is neither published nor staged. Check \`npm stage list ${name}\` and re-run this job.`)
  }
  const unverified = `\`npm stage list ${name}\` failed, so this run could not check whether ${name}@${version} is already staged`
  if (!STAGE_CONFLICT_TEXT.test(stderr)) {
    throw new Error(`${unverified}, and npm's error was not the expected conflict. Check \`npm stage list ${name}\` and re-run this job.`)
  }
  console.log(`::warning::${unverified}. The version is not published, so it is probably awaiting approval; review it with \`npm stage list ${name}\` before approving.`)
  return { status: 'skipped', detail: `${name}@${version} is already staged, contents unverified` }
}

function stageTarball (tarballPath: string, args: string[]): StageOutcome {
  console.log('$', 'npm', ...args)
  const result = spawnSync('npm', args, { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8' })
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status === 0) return { status: 'staged' }
  const code = npmErrorCode(result.stderr)
  if (code === 'E409') return resolveStageConflict(tarballPath, tarballManifest(tarballPath), result.stderr)
  throw new Error(`Command failed: npm ${args.join(' ')} (exit ${result.status ?? result.signal}${code ? `, ${code}` : ''})`)
}

interface StageReport {
  staged: string[]
  skipped: { tarball: string, detail: string }[]
  failed: { tarball: string, message: string }[]
}

function reportStageResults ({ staged, skipped, failed }: StageReport) {
  const join = (items: string[]) => items.length ? items.join(', ') : 'none'
  const skippedLines = skipped.map(({ tarball, detail }) => `${tarball} (${detail})`)
  const failedTarballs = failed.map(({ tarball }) => tarball)
  console.log(`Staged in this run: ${join(staged)}`)
  console.log(`Already staged or published: ${join(skippedLines)}`)
  console.log(`Failed: ${join(failedTarballs)}`)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  const lines = [
    '### npm publish',
    '',
    `- **Staged in this run:** ${join(staged)}`,
    `- **Already staged or published:** ${join(skippedLines)}`,
    `- **Failed:** ${join(failedTarballs)}`,
  ]
  for (const { tarball, message } of failed) lines.push(`  - \`${tarball}\`: ${message}`)
  appendFileSync(summaryPath, `${lines.join('\n')}\n`)
}

function parseTarballFiles (raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (err) {
    throw new Error(`TARBALL_FILES is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('TARBALL_FILES must be a JSON array of filenames')
  }
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !entry.endsWith('.tgz')) {
      throw new Error(`TARBALL_FILES contains a non-tarball entry: ${JSON.stringify(entry)}`)
    }
  }
  return parsed as string[]
}

const TARBALL_VERSION_RE = /-(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\.tgz$/

/** Version embedded in a `npm pack` tarball filename, if it has one. */
export function versionFromTarballName (tarball: string): string | null {
  return TARBALL_VERSION_RE.exec(tarball)?.[1] ?? null
}

/**
 * dist-tag a given version should publish to: `latest` for stable
 * versions, otherwise the prerelease identifier `uppt/pr` attached
 * (everything before the trailing counter, so `5.0.0-alpha.beta.0`
 * publishes to `alpha.beta`), or `next` when the identifier is a bare
 * number and so has no name to use.
 */
export function distTag (version: string): string {
  const prerelease = version.replace(/\+.*$/, '').split('-').slice(1).join('-')
  if (!prerelease) return 'latest'
  const parts = prerelease.split('.')
  if (parts.length > 1 && /^\d+$/.test(parts.at(-1)!)) parts.pop()
  const identifier = parts.join('.')
  if (!identifier || /^\d+$/.test(identifier)) return 'next'
  return identifier
}

function tagFor (tarball: string, override: string | undefined): string {
  if (override) return override
  const version = versionFromTarballName(tarball)
  if (!version) {
    throw new Error(`Could not parse a version out of tarball '${tarball}'; set the 'npm-tag' input to choose a dist-tag explicitly.`)
  }
  return distTag(version)
}

export function main () {
  const access = process.env.NPM_ACCESS === 'restricted' ? 'restricted' : 'public'

  const [tagOverride, ...extraTags] = parseDistTags(process.env.NPM_TAG, 'NPM_TAG')

  const dir = process.env.TARBALL_DIR
  if (!dir) throw new Error('TARBALL_DIR is required')
  if (!existsSync(dir)) throw new Error(`TARBALL_DIR does not exist: ${dir}`)

  const releases = releasesFromEnv(process.env.RELEASES)
  const nightly = process.env.NIGHTLY === 'true'
  if (nightly && releases) throw new Error('RELEASES cannot be combined with NIGHTLY')
  const command = nightly ? ['publish'] : ['stage', 'publish']
  const defaultTag = nightly ? (tagOverride ?? 'latest') : tagOverride

  const filesEnv = process.env.TARBALL_FILES?.trim()
  let tarballs: string[]
  if (filesEnv) {
    tarballs = parseTarballFiles(filesEnv)
    if (!tarballs.length) {
      throw new Error('TARBALL_FILES was provided but is empty')
    }
  }
  else if (releases) {
    tarballs = releases.map(entry => expectedTarballName(entry.name, entry.version))
  }
  else {
    tarballs = readdirSync(dir).filter(f => f.endsWith('.tgz')).sort()
    if (!tarballs.length) {
      throw new Error(`No *.tgz found in ${dir}. Did the pack job upload the artifact?`)
    }
  }

  const pending: DistTagEntry[] = []
  const staged: string[] = []
  const skipped: { tarball: string, detail: string }[] = []
  const failed: { tarball: string, message: string }[] = []
  for (const tarball of tarballs) {
    const tarballPath = resolve(dir, tarball)
    if (!existsSync(tarballPath)) {
      throw new Error(`Tarball '${tarball}' is not present in ${dir}`)
    }
    const args = [...command, tarballPath, '--provenance', '--ignore-scripts', `--access=${access}`, `--tag=${tagFor(tarball, defaultTag)}`]
    if (nightly) {
      runTolerating403('npm', args)
    }
    else {
      try {
        const outcome = stageTarball(tarballPath, args)
        if (outcome.status === 'staged') staged.push(tarball)
        else skipped.push({ tarball, detail: outcome.detail })
      }
      catch (err) {
        failed.push({ tarball, message: (err as Error).message })
        continue
      }
    }
    if (!extraTags.length) continue
    const entry = { ...tarballManifest(tarballPath), tags: extraTags }
    if (nightly) addDistTags(entry)
    else pending.push(entry)
  }

  if (!nightly) {
    reportStageResults({ staged, skipped, failed })
    if (failed.length) {
      throw new Error([
        `Could not stage ${failed.length} of ${tarballs.length} package(s):`,
        ...failed.map(({ tarball, message }) => `- ${tarball}: ${message}`),
      ].join('\n'))
    }
  }

  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) {
    appendFileSync(githubOutput, `dist-tags=${JSON.stringify(pending)}\n`)
  }
}

runMain(import.meta.url, main)
