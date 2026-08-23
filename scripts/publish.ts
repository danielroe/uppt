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
// Env:
//   NPM_ACCESS      `public` (default) or `restricted`
//   NPM_TAG         optional dist-tag override for every tarball
//   TARBALL_DIR     directory holding the prebuilt `*.tgz` files
//   TARBALL_FILES   optional JSON array of filenames within TARBALL_DIR
//   RELEASES        optional JSON payload emitted by `uppt/release` in
//                   independent mode: an array of
//                   `{ name, version, dir }`. Names the tarballs to
//                   stage when TARBALL_FILES is absent.

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { runMain } from './_cli.ts'
import { expectedTarballName, releasesFromEnv } from './_independent.ts'
import { isSemver } from './_workspaces.ts'

function run (cmd: string, args: string[]) {
  console.log('$', cmd, ...args)
  execFileSync(cmd, args, { stdio: 'inherit' })
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
const DIST_TAG_RE = /^[a-z0-9][\w.-]*$/i

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

  const tagOverride = process.env.NPM_TAG?.trim() || undefined
  if (tagOverride && (!DIST_TAG_RE.test(tagOverride) || isSemver(tagOverride))) {
    throw new Error(`NPM_TAG is not a valid dist-tag: ${JSON.stringify(tagOverride)}`)
  }

  const dir = process.env.TARBALL_DIR
  if (!dir) throw new Error('TARBALL_DIR is required')
  if (!existsSync(dir)) throw new Error(`TARBALL_DIR does not exist: ${dir}`)

  const releases = releasesFromEnv(process.env.RELEASES)

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

  for (const tarball of tarballs) {
    const tarballPath = resolve(dir, tarball)
    if (!existsSync(tarballPath)) {
      throw new Error(`Tarball '${tarball}' is not present in ${dir}`)
    }
    run('npm', ['stage', 'publish', tarballPath, '--provenance', '--ignore-scripts', `--access=${access}`, `--tag=${tagFor(tarball, tagOverride)}`])
  }
}

runMain(import.meta.url, main)
