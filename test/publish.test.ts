import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
const spawnSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync, spawnSync }))

const { main, distTag, versionFromTarballName } = await import('../scripts/publish.ts')

function fixture (files: string[]): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'uppt-publish-'))
  for (const file of files) writeFileSync(resolve(dir, file), 'x')
  return dir
}

function npmArgs () {
  return [...execFileSync.mock.calls, ...spawnSync.mock.calls].map(([, args]) => args as string[])
}

let env: NodeJS.ProcessEnv

beforeEach(() => {
  env = { ...process.env }
  for (const key of ['NPM_ACCESS', 'NPM_TAG', 'TARBALL_DIR', 'TARBALL_FILES', 'RELEASES', 'NIGHTLY', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) delete process.env[key]
  vi.spyOn(console, 'log').mockImplementation(() => {})
  spawnSync.mockReturnValue({ status: 0, stderr: '' })
})

afterEach(() => {
  process.env = env
  execFileSync.mockReset()
  spawnSync.mockReset()
  vi.restoreAllMocks()
})

describe('publish', () => {
  it('requires TARBALL_DIR', () => {
    expect(() => main()).toThrow('TARBALL_DIR is required')
  })

  it('rejects a missing TARBALL_DIR', () => {
    process.env.TARBALL_DIR = resolve(tmpdir(), 'uppt-does-not-exist')
    expect(() => main()).toThrow(/TARBALL_DIR does not exist/)
  })

  it('stages every tarball found in the directory, sorted', () => {
    process.env.TARBALL_DIR = fixture(['b-1.0.0.tgz', 'a-1.0.0.tgz', 'notes.txt'])
    main()
    expect(npmArgs()).toEqual([
      ['stage', 'publish', resolve(process.env.TARBALL_DIR!, 'a-1.0.0.tgz'), '--provenance', '--ignore-scripts', '--access=public', '--tag=latest'],
      ['stage', 'publish', resolve(process.env.TARBALL_DIR!, 'b-1.0.0.tgz'), '--provenance', '--ignore-scripts', '--access=public', '--tag=latest'],
    ])
  })

  it('honours NPM_ACCESS=restricted', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.NPM_ACCESS = 'restricted'
    main()
    expect(npmArgs()[0]).toContain('--access=restricted')
  })

  it('falls back to public for an unknown NPM_ACCESS', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.NPM_ACCESS = 'nonsense'
    main()
    expect(npmArgs()[0]).toContain('--access=public')
  })

  it('throws when the directory holds no tarballs', () => {
    process.env.TARBALL_DIR = fixture(['notes.txt'])
    expect(() => main()).toThrow(/No \*\.tgz found in/)
  })

  it('publishes TARBALL_FILES in the given order', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz', 'b-1.0.0.tgz'])
    process.env.TARBALL_FILES = '["b-1.0.0.tgz","a-1.0.0.tgz"]'
    main()
    expect(npmArgs().map(args => args[2])).toEqual([
      resolve(process.env.TARBALL_DIR!, 'b-1.0.0.tgz'),
      resolve(process.env.TARBALL_DIR!, 'a-1.0.0.tgz'),
    ])
  })

  it('rejects malformed TARBALL_FILES', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.TARBALL_FILES = '{'
    expect(() => main()).toThrow(/TARBALL_FILES is not valid JSON/)
  })

  it('rejects a non-array TARBALL_FILES', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.TARBALL_FILES = '{"a":1}'
    expect(() => main()).toThrow('TARBALL_FILES must be a JSON array of filenames')
  })

  it('rejects a TARBALL_FILES entry that is not a tarball', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.TARBALL_FILES = '["a-1.0.0.zip"]'
    expect(() => main()).toThrow(/non-tarball entry/)
  })

  it('rejects an empty TARBALL_FILES array', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.TARBALL_FILES = '[]'
    expect(() => main()).toThrow('TARBALL_FILES was provided but is empty')
  })

  it('derives tarball names from RELEASES when TARBALL_FILES is absent', () => {
    process.env.TARBALL_DIR = fixture(['nuxt-kit-5.0.0.tgz', 'stray-9.0.0.tgz'])
    process.env.RELEASES = JSON.stringify([{ name: '@nuxt/kit', version: '5.0.0', dir: 'packages/kit' }])
    main()
    expect(npmArgs().map(args => args[2])).toEqual([
      resolve(process.env.TARBALL_DIR!, 'nuxt-kit-5.0.0.tgz'),
    ])
  })

  it('throws when a named tarball is missing', () => {
    process.env.TARBALL_DIR = fixture([])
    process.env.TARBALL_FILES = '["a-1.0.0.tgz"]'
    expect(() => main()).toThrow(/Tarball 'a-1\.0\.0\.tgz' is not present/)
  })

  it('publishes nightlies directly to latest', () => {
    process.env.NIGHTLY = 'true'
    process.env.TARBALL_DIR = fixture(['a-nightly-1.0.1-2605140905-0123456.tgz'])
    main()
    expect(npmArgs()[0]).toEqual(['publish', resolve(process.env.TARBALL_DIR, 'a-nightly-1.0.1-2605140905-0123456.tgz'), '--provenance', '--ignore-scripts', '--access=public', '--tag=latest'])
  })

  it('publishes nightlies to an overridden dist-tag', () => {
    process.env.NIGHTLY = 'true'
    process.env.NPM_TAG = '5x'
    process.env.TARBALL_DIR = fixture(['a-nightly-1.0.1-2605140905-0123456.tgz'])
    main()
    expect(npmArgs()[0]).toContain('--tag=5x')
  })

  it('skips a nightly that npm rejects with E403', () => {
    process.env.NIGHTLY = 'true'
    process.env.TARBALL_DIR = fixture(['a-nightly-1.0.1-2605140905-0123456.tgz', 'b-nightly-1.0.1-2605140905-0123456.tgz'])
    spawnSync.mockReturnValueOnce({ status: 1, stderr: 'npm error code E403\n' })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    main()
    expect(npmArgs()).toHaveLength(2)
    expect(stderr).toHaveBeenCalledWith('npm error code E403\n')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('::warning::npm publish of'))
  })

  it('throws on other nightly publish failures', () => {
    process.env.NIGHTLY = 'true'
    process.env.TARBALL_DIR = fixture(['a-nightly-1.0.1-2605140905-0123456.tgz'])
    spawnSync.mockReturnValueOnce({ status: 1, stderr: 'npm error code E404\n' })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(() => main()).toThrow(/Command failed: npm publish .* \(exit 1\)/)
  })

  it('throws when a nightly publish is killed', () => {
    process.env.NIGHTLY = 'true'
    process.env.TARBALL_DIR = fixture(['a-nightly-1.0.1-2605140905-0123456.tgz'])
    spawnSync.mockReturnValueOnce({ status: null, signal: 'SIGTERM', stderr: '' })
    expect(() => main()).toThrow(/\(exit SIGTERM\)/)
  })

  it('throws when npm cannot be spawned', () => {
    process.env.NIGHTLY = 'true'
    process.env.TARBALL_DIR = fixture(['a-nightly-1.0.1-2605140905-0123456.tgz'])
    spawnSync.mockReturnValueOnce({ status: null, error: new Error('spawn npm ENOENT') })
    expect(() => main()).toThrow('spawn npm ENOENT')
  })

  it('refuses to combine nightlies with RELEASES', () => {
    process.env.NIGHTLY = 'true'
    process.env.TARBALL_DIR = fixture([])
    process.env.RELEASES = JSON.stringify([{ name: 'a', version: '1.0.0', dir: '.' }])
    expect(() => main()).toThrow(/RELEASES cannot be combined with NIGHTLY/)
  })

  it('stages prereleases under the prerelease identifier', () => {
    process.env.TARBALL_DIR = fixture(['a-5.0.0-beta.0.tgz'])
    main()
    expect(npmArgs()[0]).toContain('--tag=beta')
  })

  it('refuses to guess a tag for a tarball with no version in its name', () => {
    process.env.TARBALL_DIR = fixture(['bundle.tgz'])
    expect(() => main()).toThrow(/Could not parse a version out of tarball 'bundle\.tgz'/)
  })

  it('accepts an unversioned tarball when NPM_TAG is set', () => {
    process.env.TARBALL_DIR = fixture(['bundle.tgz'])
    process.env.NPM_TAG = 'next'
    main()
    expect(npmArgs()[0]).toContain('--tag=next')
  })

  it('derives a tag per tarball in independent mode', () => {
    process.env.TARBALL_DIR = fixture(['nuxt-kit-5.0.0-rc.1.tgz', 'nuxt-schema-4.1.0.tgz'])
    process.env.RELEASES = JSON.stringify([
      { name: '@nuxt/kit', version: '5.0.0-rc.1', dir: 'packages/kit' },
      { name: '@nuxt/schema', version: '4.1.0', dir: 'packages/schema' },
    ])
    main()
    expect(npmArgs().map(args => args.at(-1))).toEqual(['--tag=rc', '--tag=latest'])
  })

  it('honours NPM_TAG for every tarball', () => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz', 'b-5.0.0-beta.0.tgz'])
    process.env.NPM_TAG = 'legacy'
    main()
    expect(npmArgs().map(args => args.at(-1))).toEqual(['--tag=legacy', '--tag=legacy'])
  })

  describe('with several dist-tags', () => {
    let output: string

    beforeEach(() => {
      output = resolve(mkdtempSync(resolve(tmpdir(), 'uppt-output-')), 'out')
      writeFileSync(output, '')
      process.env.GITHUB_OUTPUT = output
      execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'tar') return JSON.stringify({ name: basename(args[1]!).startsWith('b-') ? '@scope/b' : 'a', version: versionFromTarballName(args[1]!) })
        if (args[1] === 'ls') return 'latest: 1.0.0\n4x: 4.0.0\n'
        return ''
      })
    })

    it('stages under the first tag and hands the rest to uppt/dist-tag', () => {
      process.env.TARBALL_DIR = fixture(['a-4.1.0.tgz', 'b-4.1.0.tgz'])
      process.env.NPM_TAG = 'latest 4x'
      main()
      expect(npmArgs().filter(args => args[0] === 'stage').map(args => args.at(-1))).toEqual(['--tag=latest', '--tag=latest'])
      expect(npmArgs().some(args => args[0] === 'dist-tag')).toBe(false)
      expect(readFileSync(output, 'utf8')).toBe(`dist-tags=${JSON.stringify([
        { name: 'a', version: '4.1.0', tags: ['4x'] },
        { name: '@scope/b', version: '4.1.0', tags: ['4x'] },
      ])}\n`)
    })

    it('adds the remaining tags straight after a nightly publish', () => {
      process.env.NIGHTLY = 'true'
      process.env.TARBALL_DIR = fixture(['a-nightly-4.1.0-2605140905-0123456.tgz'])
      process.env.NPM_TAG = '4x,latest'
      main()
      expect(npmArgs()).toContainEqual(['dist-tag', 'add', 'a@4.1.0-2605140905-0123456', 'latest'])
      expect(spawnSync.mock.calls[0]![1]).toContain('--tag=4x')
      expect(readFileSync(output, 'utf8')).toBe('dist-tags=[]\n')
    })

    it('still tags a nightly that npm rejects with E403', () => {
      process.env.NIGHTLY = 'true'
      process.env.TARBALL_DIR = fixture(['a-nightly-4.1.0-2605140905-0123456.tgz'])
      process.env.NPM_TAG = '4x latest'
      spawnSync.mockReturnValueOnce({ status: 1, stderr: 'npm error code E403\n' })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      main()
      expect(npmArgs()).toContainEqual(['dist-tag', 'add', 'a@4.1.0-2605140905-0123456', 'latest'])
    })

    it('writes an empty dist-tags output when there is a single tag', () => {
      process.env.TARBALL_DIR = fixture(['a-4.1.0.tgz'])
      main()
      expect(readFileSync(output, 'utf8')).toBe('dist-tags=[]\n')
      expect(execFileSync.mock.calls.some(([cmd]) => cmd === 'tar')).toBe(false)
    })
  })

  describe('when npm refuses to stage a version that already exists', () => {
    const STAGE_CONFLICT = [
      'npm error code E409',
      'npm error 409 Conflict - POST https://registry.npmjs.org/-/stage/package/a - Cannot stage previously published version "1.0.0".',
      'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-24T09_35_30_054Z-debug-1.log',
    ].join('\n')
    const UNAUTHENTICATED = [
      'npm error code E401',
      'npm error Unable to authenticate, your authentication token seems to be invalid.',
      'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-24T09_35_30_054Z-debug-0.log',
    ].join('\n')
    const UNEXPECTED_CONFLICT = [
      'npm error code E409',
      'npm error 409 Conflict - POST https://registry.npmjs.org/-/stage/package/a - Conflict',
    ].join('\n')
    const NOT_PUBLISHED = { status: 1, stderr: 'npm error code E404\n' }

    const sha1 = (contents: string) => createHash('sha1').update(contents).digest('hex')
    const integrity = (contents: string) => `sha512-${createHash('sha512').update(contents).digest('base64')}`

    interface NpmResponse {
      status: number | null
      signal?: string | null
      stdout?: string
      stderr?: string
      error?: Error
    }

    function mockNpm (handler: (args: string[]) => NpmResponse | undefined) {
      spawnSync.mockImplementation((_cmd: string, args: string[]) => {
        const response = handler(args)
        if (!response) throw new Error(`unexpected command: npm ${args.join(' ')}`)
        return { signal: null, stdout: '', stderr: '', ...response }
      })
    }

    function staged (entries: { packageName: string, version: string, shasum?: string, id?: string, status?: string }[]) {
      return { status: 0, stdout: JSON.stringify(entries) }
    }

    function stagePublish (conflicts: string[], failures: Record<string, NpmResponse> = {}): (args: string[]) => NpmResponse | undefined {
      return (args) => {
        if (args[0] === 'stage' && args[1] === 'publish') {
          const file = basename(args[2]!)
          const failure = failures[file]
          if (failure) return failure
          return { status: conflicts.includes(file) ? 1 : 0, stderr: conflicts.includes(file) ? STAGE_CONFLICT : '' }
        }
        return undefined
      }
    }

    beforeEach(() => {
      execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd !== 'tar') throw new Error(`unexpected command: ${cmd}`)
        const file = basename(args[1]!)
        return JSON.stringify({ name: file.replace(/-\d.*$/, ''), version: versionFromTarballName(file) })
      })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    })

    it('skips a version that is staged with the same tarball and carries on', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz', 'b-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ id: 'stage-a', packageName: 'a', version: '1.0.0', shasum: sha1('x') }])
        return publish(args)
      })
      main()
      expect(npmArgs().filter(args => args[0] === 'stage' && args[1] === 'publish').map(args => basename(args[2]!))).toEqual(['a-1.0.0.tgz', 'b-1.0.0.tgz'])
      expect(npmArgs()).toContainEqual(['view', 'a@1.0.0', 'dist.integrity', 'dist.shasum', '--json'])
      expect(npmArgs()).toContainEqual(['stage', 'list', 'a', '--json'])
      expect(console.log).toHaveBeenCalledWith('Staged in this run: b-1.0.0.tgz')
      expect(console.log).toHaveBeenCalledWith('Already staged or published: a-1.0.0.tgz (a@1.0.0 is already staged)')
      expect(console.log).toHaveBeenCalledWith('Failed: none')
    })

    it('fails when the staged tarball differs from the one this run packed', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ id: 'f8238ffb-b2ef-46a3-b705-2bc7edd6d533', packageName: 'a', version: '1.0.0', shasum: sha1('some other tarball') }])
        return publish(args)
      })
      expect(() => main()).toThrow('a@1.0.0 is already staged (f8238ffb-b2ef-46a3-b705-2bc7edd6d533) with different contents. Reject each staged copy with `npm stage reject <id>`, then re-run this job.')
    })

    it('names every staged copy when none of them match', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') {
          return staged([
            { id: 'first-copy', packageName: 'a', version: '1.0.0', shasum: sha1('some other tarball') },
            { id: 'second-copy', packageName: 'a', version: '1.0.0', shasum: sha1('a third tarball') },
          ])
        }
        return publish(args)
      })
      expect(() => main()).toThrow('a@1.0.0 is already staged (first-copy, second-copy) with different contents.')
    })

    it('ignores staged entries that are no longer pending', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') {
          return staged([
            { id: 'old-copy', packageName: 'a', version: '1.0.0', shasum: sha1('x'), status: 'rejected' },
            { id: 'live-copy', packageName: 'a', version: '1.0.0', shasum: sha1('some other tarball'), status: 'validating' },
          ])
        }
        return publish(args)
      })
      expect(() => main()).toThrow('a@1.0.0 is already staged (live-copy) with different contents.')
    })

    it('fails when every staged entry for the version is no longer pending', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') {
          return staged([{ id: 'old-copy', packageName: 'a', version: '1.0.0', shasum: sha1('x'), status: 'approved' }])
        }
        return publish(args)
      })
      expect(() => main()).toThrow(/but that version is neither published nor staged/)
    })

    it('tells the user to find the staged entry when npm does not report its id', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ packageName: 'a', version: '1.0.0', shasum: sha1('some other tarball') }])
        return publish(args)
      })
      expect(() => main()).toThrow('a@1.0.0 is already staged (npm reported no id) with different contents. Reject each staged copy with `npm stage reject <id>`, then re-run this job.')
    })

    it('skips a staged version with no shasum when npm reports the known conflict', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ id: 'stage-a', packageName: 'a', version: '1.0.0' }])
        return publish(args)
      })
      main()
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('npm reported no shasum for it'))
      expect(console.log).toHaveBeenCalledWith('Already staged or published: a-1.0.0.tgz (a@1.0.0 is already staged, contents unverified)')
    })

    it('fails a staged version with no shasum when npm reports an unexpected conflict', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'stage' && args[1] === 'publish') return { status: 1, stderr: UNEXPECTED_CONFLICT }
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ id: 'stage-a', packageName: 'a', version: '1.0.0' }])
        return undefined
      })
      expect(() => main()).toThrow(/a@1\.0\.0 is already staged \(stage-a\), but npm reported no shasum for it, so this run could not check that the staged tarball matches\. npm's error was not the expected conflict/)
    })

    it('skips a version that is already published from the same tarball', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return { status: 0, stdout: JSON.stringify({ 'dist.integrity': integrity('x'), 'dist.shasum': sha1('x') }) }
        return stagePublish(['a-1.0.0.tgz'])(args)
      })
      main()
      expect(console.log).toHaveBeenCalledWith('Already staged or published: a-1.0.0.tgz (a@1.0.0 is already published)')
      expect(npmArgs().some(args => args[0] === 'stage' && args[1] === 'list')).toBe(false)
    })

    it('compares the shasum when the registry reports no integrity', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return { status: 0, stdout: JSON.stringify({ 'dist.shasum': sha1('x') }) }
        return stagePublish(['a-1.0.0.tgz'])(args)
      })
      main()
      expect(console.log).toHaveBeenCalledWith('Already staged or published: a-1.0.0.tgz (a@1.0.0 is already published)')
    })

    it('fails when the published version came from a different tarball', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return { status: 0, stdout: JSON.stringify({ 'dist.integrity': integrity('some other tarball'), 'dist.shasum': sha1('x') }) }
        return stagePublish(['a-1.0.0.tgz'])(args)
      })
      expect(() => main()).toThrow(`a@1.0.0 is already published with different contents: the registry has ${integrity('some other tarball')}, this run's tarball is ${integrity('x')}.`)
    })

    it('fails when the published version has no integrity and a different shasum', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return { status: 0, stdout: JSON.stringify({ 'dist.shasum': sha1('some other tarball') }) }
        return stagePublish(['a-1.0.0.tgz'])(args)
      })
      expect(() => main()).toThrow(`the registry has ${sha1('some other tarball')}`)
    })

    it('fails when the published state cannot be checked', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return { status: 1, stderr: 'npm error code E500\n' }
        return stagePublish(['a-1.0.0.tgz'])(args)
      })
      expect(() => main()).toThrow('Could not check whether a@1.0.0 is already published. npm view reported E500.')
    })

    it('fails when the published state check fails without an error code', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return { status: 1, stderr: 'connection reset\n' }
        return stagePublish(['a-1.0.0.tgz'])(args)
      })
      let message = ''
      try { main() }
      catch (err) { message = (err as Error).message }
      expect(message).toContain('Could not check whether a@1.0.0 is already published.')
      expect(message).not.toContain('npm view reported')
    })

    it('treats unparseable npm view output as not published', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return { status: 0, stdout: 'not json' }
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ packageName: 'a', version: '1.0.0', shasum: sha1('x') }])
        return publish(args)
      })
      main()
      expect(console.log).toHaveBeenCalledWith('Already staged or published: a-1.0.0.tgz (a@1.0.0 is already staged)')
    })

    it('skips with a warning when the staged versions cannot be listed', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return { status: 1, stderr: 'npm error code E403\n' }
        return publish(args)
      })
      main()
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('this run could not check whether a@1.0.0 is already staged'))
      expect(console.log).toHaveBeenCalledWith('Already staged or published: a-1.0.0.tgz (a@1.0.0 is already staged, contents unverified)')
    })

    it('fails when the staged versions cannot be listed and npm reports an unexpected conflict', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'stage' && args[1] === 'publish') return { status: 1, stderr: UNEXPECTED_CONFLICT }
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return { status: 1, stderr: 'npm error code E401\n' }
        return undefined
      })
      expect(() => main()).toThrow(/`npm stage list a` failed, so this run could not check whether a@1\.0\.0 is already staged, and npm's error was not the expected conflict/)
    })

    it('skips with a warning when the staged versions are not JSON', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return { status: 0, stdout: 'not json' }
        return publish(args)
      })
      main()
      expect(console.log).toHaveBeenCalledWith('Already staged or published: a-1.0.0.tgz (a@1.0.0 is already staged, contents unverified)')
    })

    it('skips with a warning when the staged versions are not a list', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return { status: 0, stdout: '{"items":[]}' }
        return publish(args)
      })
      main()
      expect(console.log).toHaveBeenCalledWith('Already staged or published: a-1.0.0.tgz (a@1.0.0 is already staged, contents unverified)')
    })

    it('fails when the conflicting version is neither published nor staged', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') {
          return staged([
            { packageName: 'b', version: '1.0.0', shasum: sha1('x') },
            { packageName: 'a', version: '2.0.0', shasum: sha1('x') },
          ])
        }
        return publish(args)
      })
      expect(() => main()).toThrow(/npm reported a conflict staging a@1\.0\.0, but that version is neither published nor staged\. Check `npm stage list a`/)
    })

    it('fails the job when reading the staged versions cannot be spawned', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return { status: null, error: new Error('spawn npm ENOENT') }
        return publish(args)
      })
      expect(() => main()).toThrow('spawn npm ENOENT')
    })

    it('fails on a stage that npm rejects with E403 and still attempts the rest', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz', 'b-1.0.0.tgz'])
      mockNpm(stagePublish([], { 'a-1.0.0.tgz': { status: 1, stderr: 'npm error code E403\n' } }))
      expect(() => main()).toThrow(/Could not stage 1 of 2 package\(s\):[\s\S]*a-1\.0\.0\.tgz: Command failed: npm stage publish .*\(exit 1, E403\)/)
      expect(console.log).toHaveBeenCalledWith('Staged in this run: b-1.0.0.tgz')
    })

    it('forwards npm stderr from a successful stage', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const stderr = vi.spyOn(process.stderr, 'write')
      mockNpm(stagePublish([], {}))
      spawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: 'npm notice staged a@1.0.0\n', signal: null })
      main()
      expect(stderr).toHaveBeenCalledWith('npm notice staged a@1.0.0\n')
    })

    it('attempts every package before failing with a summary', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz', 'b-1.0.0.tgz', 'c-1.0.0.tgz'])
      const publish = stagePublish(['c-1.0.0.tgz'], { 'a-1.0.0.tgz': { status: 1, stderr: UNAUTHENTICATED } })
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ packageName: 'c', version: '1.0.0', shasum: sha1('x') }])
        return publish(args)
      })
      expect(() => main()).toThrow(/Could not stage 1 of 3 package\(s\):[\s\S]*a-1\.0\.0\.tgz: Command failed: npm stage publish .*\(exit 1, E401\)/)
      expect(npmArgs().filter(args => args[0] === 'stage' && args[1] === 'publish').map(args => basename(args[2]!))).toEqual(['a-1.0.0.tgz', 'b-1.0.0.tgz', 'c-1.0.0.tgz'])
    })

    it('reports a stage that npm killed', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm(stagePublish([], { 'a-1.0.0.tgz': { status: null, signal: 'SIGTERM', stderr: '' } }))
      expect(() => main()).toThrow(/Could not stage 1 of 1 package\(s\):[\s\S]*\(exit SIGTERM\)/)
    })

    it('reports a stage that npm could not be spawned for', () => {
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      mockNpm(stagePublish([], { 'a-1.0.0.tgz': { status: null, error: new Error('spawn npm ENOENT') } }))
      expect(() => main()).toThrow(/Could not stage 1 of 1 package\(s\):[\s\S]*a-1\.0\.0\.tgz: spawn npm ENOENT/)
    })

    it('writes staged, skipped and failed packages to the job summary', () => {
      const output = resolve(mkdtempSync(resolve(tmpdir(), 'uppt-summary-')), 'summary')
      writeFileSync(output, '')
      process.env.GITHUB_STEP_SUMMARY = output
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz', 'b-1.0.0.tgz', 'c-1.0.0.tgz'])
      const publish = stagePublish(['c-1.0.0.tgz'], { 'b-1.0.0.tgz': { status: 1, stderr: UNAUTHENTICATED } })
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ packageName: 'c', version: '1.0.0', shasum: sha1('x') }])
        return publish(args)
      })
      expect(() => main()).toThrow('Could not stage 1 of 3 package(s):')
      const summary = readFileSync(output, 'utf8')
      expect(summary).toContain('### npm publish')
      expect(summary).toContain('- **Staged in this run:** a-1.0.0.tgz')
      expect(summary).toContain('- **Already staged or published:** c-1.0.0.tgz (c@1.0.0 is already staged)')
      expect(summary).toContain('- **Failed:** b-1.0.0.tgz')
      expect(summary).toContain('  - `b-1.0.0.tgz`: Command failed: npm stage publish')
    })

    it('still stages the extra dist-tags of a version that was already staged', () => {
      const output = resolve(mkdtempSync(resolve(tmpdir(), 'uppt-output-')), 'out')
      writeFileSync(output, '')
      process.env.GITHUB_OUTPUT = output
      process.env.NPM_TAG = 'latest 4x'
      process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
      const publish = stagePublish(['a-1.0.0.tgz'])
      mockNpm((args) => {
        if (args[0] === 'view') return NOT_PUBLISHED
        if (args[0] === 'stage' && args[1] === 'list') return staged([{ packageName: 'a', version: '1.0.0', shasum: sha1('x') }])
        return publish(args)
      })
      main()
      expect(readFileSync(output, 'utf8')).toBe(`dist-tags=${JSON.stringify([{ name: 'a', version: '1.0.0', tags: ['4x'] }])}\n`)
    })
  })

  it.each(['-bad', 'a/b', '1.2.3', 'latest 1.2.3'])('rejects an invalid NPM_TAG (%s)', (tag) => {
    process.env.TARBALL_DIR = fixture(['a-1.0.0.tgz'])
    process.env.NPM_TAG = tag
    expect(() => main()).toThrow(/NPM_TAG is not a valid dist-tag/)
  })
})

describe('distTag', () => {
  it.each([
    ['1.2.3', 'latest'],
    ['5.0.0-beta.0', 'beta'],
    ['5.0.0-rc.1', 'rc'],
    ['5.0.0-0', 'next'],
    ['5.0.0-alpha', 'alpha'],
    ['5.0.0-alpha.beta.0', 'alpha.beta'],
    ['5.0.0-pre-view.0', 'pre-view'],
    ['5.0.0-1.2', 'next'],
    ['5.0.0-beta.0+build.1', 'beta'],
    ['1.2.3+build.1', 'latest'],
  ])('maps %s to %s', (version, tag) => {
    expect(distTag(version)).toBe(tag)
  })
})

describe('versionFromTarballName', () => {
  it('extracts the version', () => {
    expect(versionFromTarballName('nuxt-kit-5.0.0-beta.0.tgz')).toBe('5.0.0-beta.0')
    expect(versionFromTarballName('a-1.0.0.tgz')).toBe('1.0.0')
  })

  it('returns null for an unversioned filename', () => {
    expect(versionFromTarballName('bundle.tgz')).toBe(null)
  })
})
