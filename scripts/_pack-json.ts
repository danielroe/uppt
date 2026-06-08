// Parse the `--json` output of `npm pack` / `pnpm pack`.
//
// `npm pack --json` emits an array of pack records with a bare
// `filename`; `pnpm pack --json` emits a single object whose
// `filename` is an absolute path. Both tools run lifecycle scripts
// (`prepare`, `prepack`) before emitting their JSON, and tools like
// unbuild print to stdout (e.g. `[INFO] ...`), so the captured stdout
// is a mix of script output followed by a single trailing JSON value.
// We locate that trailing value rather than parsing the whole buffer,
// and normalise filenames to basenames so the step output matches
// what `actions/upload-artifact` puts in the artifact (and what
// `publish.ts` resolves under `TARBALL_DIR`).

import { basename } from 'node:path'

export function extractTrailingJson (stdout: string): unknown {
  const trimmed = stdout.replace(/\s+$/, '')
  if (!trimmed) {
    throw new Error('Pack tool produced no output on stdout')
  }
  const last = trimmed[trimmed.length - 1]
  if (last !== '}' && last !== ']') {
    throw new Error(`Pack tool stdout did not end with a JSON value:\n${stdout}`)
  }
  const open = last === '}' ? '{' : '['
  const candidates: number[] = []
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === open && (i === 0 || trimmed[i - 1] === '\n')) {
      candidates.push(i)
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(trimmed.slice(candidates[i]!))
    }
    catch {}
  }
  throw new Error(`Could not find a JSON value in pack tool stdout:\n${stdout}`)
}

export function parseFilenames (stdout: string): string[] {
  const data = extractTrailingJson(stdout)
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
