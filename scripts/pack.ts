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
//   GITHUB_OUTPUT    set by the runner; receives `files=<json array>`.
//   GITHUB_REF       must be `refs/tags/v*` (set automatically)
//   PACKAGES         newline-separated list of publishable workspace
//                    paths/globs; when set, the script packs each
//                    listed workspace instead of the root.
//   RELEASES         optional JSON payload emitted by `uppt/release` in
//                    independent mode: an ordered array of
//                    `{ name, version, dir }`. When set, exactly those
//                    workspaces are packed, in that order, and the ref
//                    must be a `release-YYYY-MM-DD` coordination
//                    tag instead of `vX.Y.Z`.

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseFilenames } from './_pack-json.ts'
import { resolveWorkspaces } from './_workspaces.ts'
import { COORDINATION_TAG_RE, releasesFromEnv, type ReleaseEntry } from './_independent.ts'

function runCapture (cmd: string, args: string[], cwd?: string): string {
  console.log('$', cmd, ...args, cwd ? `(cwd: ${cwd})` : '')
  return execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    cwd,
  })
}

function releaseTargets (rootDir: string, releases: ReleaseEntry[]): Array<{ name: string, cwd: string }> {
  return releases.map((entry) => {
    const dir = resolve(rootDir, entry.dir)
    const pkgPath = resolve(dir, 'package.json')
    if (!existsSync(pkgPath)) {
      throw new Error(`RELEASES entry for ${entry.name} points at ${entry.dir}, which has no package.json`)
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string, version?: string, private?: boolean }
    if (pkg.private === true) {
      throw new Error(`RELEASES entry for ${entry.name} points at a private package (${entry.dir})`)
    }
    if (pkg.name !== entry.name || pkg.version !== entry.version) {
      throw new Error(`RELEASES entry ${entry.name}@${entry.version} does not match ${entry.dir}/package.json (${pkg.name}@${pkg.version}). Is the workflow running on the right ref?`)
    }
    return { name: entry.name, cwd: dir }
  })
}

function main () {
  const ref = process.env.GITHUB_REF ?? ''
  const releases = releasesFromEnv(process.env.RELEASES)

  if (releases) {
    const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ''
    if (!COORDINATION_TAG_RE.test(tag)) {
      throw new Error(`RELEASES is set, so GITHUB_REF must be a 'refs/tags/release-YYYY-MM-DD' coordination tag, got '${ref || '<unset>'}'`)
    }
  }
  else {
    if (!ref.startsWith('refs/tags/v')) {
      throw new Error(`GITHUB_REF must be a 'refs/tags/v*' ref, got '${ref || '<unset>'}'`)
    }
    const tag = ref.slice('refs/tags/'.length)
    if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(tag)) {
      throw new Error(`Refusing to pack: tag "${tag}" is not strict semver`)
    }
  }
  const tag = ref.slice('refs/tags/'.length)

  const outDir = process.env.PACK_OUT_DIR
  if (!outDir) throw new Error('PACK_OUT_DIR is required')
  mkdirSync(outDir, { recursive: true })

  const hasPnpmLock = existsSync(resolve(process.cwd(), 'pnpm-lock.yaml'))
  const packagesInput = process.env.PACKAGES?.trim() ?? ''
  const targets = releases
    ? releaseTargets(process.cwd(), releases)
    : packagesInput.length
      ? resolveWorkspaces(process.cwd(), packagesInput).map(ws => ({ name: ws.name, cwd: ws.dir }))
      : [{ name: '<root>', cwd: process.cwd() }]

  const filenames: string[] = []
  for (const target of targets) {
    const stdout = hasPnpmLock
      ? runCapture('pnpm', ['pack', '--pack-destination', outDir, '--json'], target.cwd)
      : runCapture('npm', ['pack', '--pack-destination', outDir, '--json', '--silent'], target.cwd)
    const packed = parseFilenames(stdout)
    for (const filename of packed) {
      if (filenames.includes(filename)) {
        throw new Error(`Pack tool produced duplicate tarball '${filename}' (from ${target.name}); workspace package names and versions must be unique.`)
      }
      filenames.push(filename)
    }
  }

  for (const filename of filenames) {
    const tarballPath = resolve(outDir, filename)
    if (!existsSync(tarballPath)) {
      throw new Error(`Pack tool reported '${filename}' but it is not present in ${outDir}`)
    }
    const size = statSync(tarballPath).size
    console.log(`Packed ${filename} (${size} bytes) for ${tag}`)
  }

  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) {
    appendFileSync(githubOutput, `files=${JSON.stringify(filenames)}\n`)
  }
}

try {
  main()
}
catch (err) {
  console.error(err)
  process.exit(1)
}
