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

import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

function runCapture (cmd: string, args: string[]): string {
  console.log('$', cmd, ...args)
  return execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
}

// `npm pack --json` emits an array of pack records with a bare
// `filename`; `pnpm pack --json` emits a single object whose
// `filename` is an absolute path. Normalise both to basenames so the
// step output matches what `actions/upload-artifact` puts in the
// artifact (and what `publish.ts` resolves under `TARBALL_DIR`).
function parseFilenames (stdout: string): string[] {
  const data = JSON.parse(stdout) as unknown
  const records = Array.isArray(data) ? data : [data]
  const filenames: string[] = []
  for (const entry of records) {
    if (!entry || typeof entry !== 'object' || !('filename' in entry)) {
      throw new Error(`Unexpected pack JSON entry without 'filename': ${JSON.stringify(entry)}`)
    }
    const filename = (entry as { filename: unknown }).filename
    if (typeof filename !== 'string' || !filename.endsWith('.tgz')) {
      throw new Error(`Unexpected pack JSON 'filename': ${JSON.stringify(filename)}`)
    }
    filenames.push(basename(filename))
  }
  if (!filenames.length) {
    throw new Error('Pack tool produced JSON with no tarball filenames')
  }
  return filenames
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

  const hasPnpmLock = existsSync(resolve(process.cwd(), 'pnpm-lock.yaml'))

  let stdout: string
  if (hasPnpmLock) {
    stdout = runCapture('pnpm', ['pack', '--pack-destination', outDir, '--json'])
  } else {
    stdout = runCapture('npm', ['pack', '--pack-destination', outDir, '--json', '--silent'])
  }

  const filenames = parseFilenames(stdout)

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
