// Apply the extra dist-tags `uppt/publish` could not set on staged
// versions, once a maintainer has approved them on npmjs.com.
//
// A staged version carries a single tag and cannot be tagged further
// until it is live, so this polls the registry for each version and
// tags it as soon as it appears. Tags only move forward, so rerunning
// the job after a timeout is safe.
//
// Env:
//   DIST_TAGS         JSON array of `{ name, version, tags }`, from the
//                     `dist-tags` output of `uppt/publish`
//   TIMEOUT_MINUTES   how long to wait for approval (default 30)

import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { runMain } from './_cli.ts'
import { addDistTags, parseDistTagEntries, type DistTagEntry } from './_dist-tags.ts'

const POLL_SECONDS = 30

function isLive ({ name, version }: DistTagEntry): boolean {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--prefer-online'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 0) return true
  if (/\bE404\b/.test(result.stderr)) return false
  throw new Error(`npm view ${name}@${version} failed (exit ${result.status ?? result.signal}):\n${result.stderr}`)
}

function label (entries: DistTagEntry[]): string {
  return entries.map(entry => `${entry.name}@${entry.version}`).join(', ')
}

export async function main (sleep: (ms: number) => Promise<unknown> = delay) {
  let pending = parseDistTagEntries(process.env.DIST_TAGS)
  if (!pending.length) {
    console.log('No dist-tags to apply.')
    return
  }

  const raw = process.env.TIMEOUT_MINUTES?.trim() || '30'
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`TIMEOUT_MINUTES must be a non-negative number, got ${JSON.stringify(raw)}`)
  }
  const attempts = Math.ceil(minutes * 60 / POLL_SECONDS) + 1

  for (let attempt = 1; ; attempt++) {
    pending = pending.filter((entry) => {
      if (!isLive(entry)) return true
      addDistTags(entry)
      return false
    })
    if (!pending.length) return
    if (attempt >= attempts) break
    console.log(`Waiting for ${label(pending)} to be approved on npmjs.com...`)
    await sleep(POLL_SECONDS * 1000)
  }

  throw new Error(`Timed out after ${minutes} minute(s) waiting for ${label(pending)} to go live. Approve the staged version(s) on npmjs.com, then re-run this job.`)
}

runMain(import.meta.url, main)
