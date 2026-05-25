// Stage-publish prebuilt tarball(s) to npm using OIDC trusted
// publishing. The maintainer approves the staged version with 2FA on
// npmjs.com afterwards.
//
// The tarball(s) were produced by `uppt/pack` in an earlier job in the
// same workflow run and downloaded into `TARBALL_DIR` by
// `actions/download-artifact`.
//
// `npm publish <tarball>` doesn't run lifecycle scripts in any case
// (the tarball is treated as an opaque artifact), but we still pass
// `--ignore-scripts` for clarity.
//
// Env:
//   NPM_ACCESS    `public` (default) or `restricted`
//   TARBALL_DIR   directory holding the prebuilt `*.tgz` files

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function run (cmd: string, args: string[]) {
  console.log('$', cmd, ...args)
  execFileSync(cmd, args, { stdio: 'inherit' })
}

function findTarballs (dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith('.tgz')).sort()
}

function main () {
  const access = process.env.NPM_ACCESS === 'restricted' ? 'restricted' : 'public'

  const dir = process.env.TARBALL_DIR
  if (!dir) throw new Error('TARBALL_DIR is required')
  if (!existsSync(dir)) throw new Error(`TARBALL_DIR does not exist: ${dir}`)

  const tarballs = findTarballs(dir)
  if (!tarballs.length) {
    throw new Error(`No *.tgz found in ${dir}. Did the pack job upload the artifact?`)
  }

  for (const tarball of tarballs) {
    const tarballPath = resolve(dir, tarball)
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
