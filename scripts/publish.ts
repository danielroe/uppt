// Stage-publish to npm using OIDC trusted publishing. The maintainer
// approves the staged version with 2FA on npmjs.com afterwards.
//
// Two paths, differing only in what gets staged:
//   - pnpm-lock.yaml present: `pnpm pack` first so `catalog:` specifiers
//     resolve in the tarball, then `npm stage publish ./<tarball>.tgz`.
//   - otherwise: `npm stage publish` from source (no tarball arg).
//
// Env:
//   NPM_ACCESS    `public` (default) or `restricted`

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function run (cmd: string, args: string[]) {
  console.log('$', cmd, ...args)
  execFileSync(cmd, args, { stdio: 'inherit' })
}

function tarballGlobPrefix (pkgName: string): string {
  // npm pack names tarballs `<name>-<version>.tgz` for unscoped packages
  // and `<scope>-<name>-<version>.tgz` for scoped ones (the leading `@`
  // is stripped and the `/` becomes `-`).
  return pkgName.replace(/^@/, '').replace(/\//g, '-')
}

function findTarballs (prefix: string): string[] {
  return readdirSync(process.cwd())
    .filter(f => f.startsWith(`${prefix}-`) && f.endsWith('.tgz'))
    .sort()
}

function main () {
  const access = process.env.NPM_ACCESS === 'restricted' ? 'restricted' : 'public'
  const pkgPath = resolve(process.cwd(), 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string }
  const hasPnpmLock = existsSync(resolve(process.cwd(), 'pnpm-lock.yaml'))

  if (!hasPnpmLock) {
    run('npm', ['stage', 'publish', '--provenance', `--access=${access}`])
    return
  }

  run('pnpm', ['pack', '--pack-destination', '.'])

  const prefix = tarballGlobPrefix(pkg.name)
  const tarballs = findTarballs(prefix)
  if (!tarballs.length) {
    throw new Error(`No tarball matching ${prefix}-*.tgz found in ${process.cwd()}`)
  }
  for (const tarball of tarballs) {
    run('npm', ['stage', 'publish', `./${tarball}`, '--provenance', `--access=${access}`])
  }
}

try {
  main()
}
catch (err) {
  console.error(err)
  process.exit(1)
}
