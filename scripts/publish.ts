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
// Env:
//   NPM_ACCESS      `public` (default) or `restricted`
//   TARBALL_DIR     directory holding the prebuilt `*.tgz` files
//   TARBALL_FILES   optional JSON array of filenames within TARBALL_DIR

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

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

function main () {
  const access = process.env.NPM_ACCESS === 'restricted' ? 'restricted' : 'public'

  const dir = process.env.TARBALL_DIR
  if (!dir) throw new Error('TARBALL_DIR is required')
  if (!existsSync(dir)) throw new Error(`TARBALL_DIR does not exist: ${dir}`)

  const filesEnv = process.env.TARBALL_FILES?.trim()
  let tarballs: string[]
  if (filesEnv) {
    tarballs = parseTarballFiles(filesEnv)
    if (!tarballs.length) {
      throw new Error('TARBALL_FILES was provided but is empty')
    }
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
    run('npm', ['stage', 'publish', tarballPath, '--provenance', '--ignore-scripts', `--access=${access}`])
  }
}

try {
  main()
}
catch (err) {
  console.error(err)
  process.exit(1)
}
