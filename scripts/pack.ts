// Pack the current tag into one or more tarballs in `PACK_OUT_DIR`.
// The composite action then hands those tarballs to a workflow artifact
// upload step; the `publish` job in the same workflow run downloads the
// artifact and runs `npm stage publish` on the tarball without ever
// installing the package's dependencies.
//
// Two paths:
//   - pnpm-lock.yaml present: `pnpm pack` so `catalog:` specifiers get
//     resolved into the tarball.
//   - otherwise: `npm pack`.
//
// Env:
//   PACK_OUT_DIR     directory to write the `*.tgz` into (created if
//                    missing). The action then uploads its contents as
//                    a workflow artifact.
//   GITHUB_REF       must be `refs/tags/v*` (set automatically)

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

function run (cmd: string, args: string[], cwd?: string) {
  console.log('$', cmd, ...args, cwd ? `(cwd: ${cwd})` : '')
  execFileSync(cmd, args, { stdio: 'inherit', cwd })
}

function tarballGlobPrefix (pkgName: string): string {
  // npm/pnpm pack names tarballs `<name>-<version>.tgz` for unscoped
  // packages and `<scope>-<name>-<version>.tgz` for scoped ones (the
  // leading `@` is stripped and the `/` becomes `-`).
  return pkgName.replace(/^@/, '').replace(/\//g, '-')
}

function findTarballs (dir: string, prefix: string): string[] {
  return readdirSync(dir)
    .filter(f => f.startsWith(`${prefix}-`) && f.endsWith('.tgz'))
    .sort()
}

function main () {
  const ref = process.env.GITHUB_REF ?? ''
  if (!ref.startsWith('refs/tags/v')) {
    throw new Error(`GITHUB_REF must be a 'refs/tags/v*' ref, got '${ref || '<unset>'}'`)
  }
  const tag = ref.slice('refs/tags/'.length)
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(tag)) {
    throw new Error(`Refusing to pack: tag "${tag}" is not strict semver`)
  }

  const outDir = process.env.PACK_OUT_DIR
  if (!outDir) throw new Error('PACK_OUT_DIR is required')
  mkdirSync(outDir, { recursive: true })

  const pkgPath = resolve(process.cwd(), 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string }
  const hasPnpmLock = existsSync(resolve(process.cwd(), 'pnpm-lock.yaml'))

  if (hasPnpmLock) {
    run('pnpm', ['pack', '--pack-destination', outDir])
  } else {
    run('npm', ['pack', '--pack-destination', outDir])
  }

  const prefix = tarballGlobPrefix(pkg.name)
  const tarballs = findTarballs(outDir, prefix)
  if (!tarballs.length) {
    throw new Error(`No tarball matching ${prefix}-*.tgz found in ${outDir} after pack`)
  }

  for (const tarball of tarballs) {
    const size = statSync(resolve(outDir, tarball)).size
    console.log(`Packed ${tarball} (${size} bytes) for ${tag}`)
  }
}

try {
  main()
}
catch (err) {
  console.error(err)
  process.exit(1)
}
