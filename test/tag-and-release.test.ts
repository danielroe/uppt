import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))

const { main } = await import('../scripts/tag-and-release.ts')

const TAG_ENV = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'MODE', 'PACKAGES', 'PR_BODY', 'PUBLISH_WORKFLOW'] as const

let env: NodeJS.ProcessEnv
let cwd: string
let root: string
let existingTags: string[]

/**
 * Route the mocked `execFileSync` to plausible git/gh responses. Tags in
 * `existingTags` are reported by both `git for-each-ref` and `gh api`.
 */
function stubGit () {
  execFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'for-each-ref') return existingTags.join('\n') + '\n'
    if (cmd === 'git' && args[0] === 'rev-parse') return 'deadbeef\n'
    if (cmd === 'gh' && args[0] === 'api' && args[1] !== '-X') {
      const tag = args[args.length - 1]!.replace(/^.*\/git\/ref\/tags\//, '')
      if (!existingTags.includes(tag)) throw new Error('gh: 404')
      return '{"ref":"refs/tags/x"}'
    }
    return ''
  })
}

function ghCalls () {
  return execFileSync.mock.calls.filter(([cmd]) => cmd === 'gh').map(([, args]) => args as string[])
}

function writePkg (dir: string, pkg: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(pkg))
}

beforeEach(() => {
  env = { ...process.env }
  cwd = process.cwd()
  for (const key of TAG_ENV) delete process.env[key]
  process.env.GITHUB_TOKEN = 'tok'
  process.env.GITHUB_REPOSITORY = 'owner/repo'
  root = mkdtempSync(resolve(tmpdir(), 'uppt-release-'))
  writePkg(root, { name: 'root-pkg', version: '1.2.3' })
  process.chdir(root)
  existingTags = []
  stubGit()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  process.chdir(cwd)
  process.env = env
  execFileSync.mockReset()
  vi.restoreAllMocks()
})

describe('tag-and-release', () => {
  it('requires a token', () => {
    delete process.env.GITHUB_TOKEN
    expect(() => main()).toThrow('GITHUB_TOKEN is required')
  })

  it('rejects a malformed repository', () => {
    process.env.GITHUB_REPOSITORY = 'norepo'
    expect(() => main()).toThrow('GITHUB_REPOSITORY is required')
  })

  it('rejects an unknown mode', () => {
    process.env.MODE = 'whatever'
    expect(() => main()).toThrow(/expected "lockstep" or "independent"/)
  })

  it('rejects a non-semver version', () => {
    writePkg(root, { name: 'root-pkg', version: 'nightly' })
    expect(() => main()).toThrow(/is not strict semver/)
  })

  it('tags, releases and dispatches in lockstep mode', () => {
    process.env.PR_BODY = 'notes'
    main()
    expect(ghCalls()).toEqual([
      ['api', '-H', 'Accept: application/vnd.github+json', '/repos/owner/repo/git/ref/tags/v1.2.3'],
      ['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json', '/repos/owner/repo/git/refs', '-f', 'ref=refs/tags/v1.2.3', '-f', 'sha=deadbeef'],
      ['release', 'create', 'v1.2.3', '--title', 'v1.2.3', '--notes', 'notes'],
      ['workflow', 'run', 'release.yml', '--ref', 'v1.2.3'],
    ])
  })

  it('dispatches a custom publish workflow', () => {
    process.env.PUBLISH_WORKFLOW = 'publish.yml'
    main()
    expect(ghCalls().at(-1)).toEqual(['workflow', 'run', 'publish.yml', '--ref', 'v1.2.3'])
  })

  it('marks a prerelease version as a prerelease', () => {
    writePkg(root, { name: 'root-pkg', version: '1.2.3-beta.0' })
    main()
    expect(ghCalls().at(-2)).toEqual(['release', 'create', 'v1.2.3-beta.0', '--title', 'v1.2.3-beta.0', '--notes', '', '--prerelease'])
  })

  it('refuses to retag an existing version', () => {
    existingTags = ['v1.2.3']
    expect(() => main()).toThrow(/already exists on owner\/repo/)
  })

  describe('independent mode', () => {
    beforeEach(() => {
      process.env.MODE = 'independent'
      process.env.PACKAGES = 'packages/*'
      writePkg(resolve(root, 'packages/kit'), { name: '@nuxt/kit', version: '5.0.0' })
      writePkg(resolve(root, 'packages/ui'), { name: '@nuxt/ui', version: '2.0.0' })
      existingTags = ['@nuxt/kit@4.0.0', '@nuxt/ui@2.0.0']
      vi.setSystemTime(new Date('2024-05-01T00:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('requires the packages input', () => {
      delete process.env.PACKAGES
      expect(() => main()).toThrow(/requires the `packages` input/)
    })

    it('tags only the packages whose version changed', () => {
      main()
      const created = ghCalls().filter(args => args[1] === '-X').map(args => args[7])
      expect(created).toEqual(['ref=refs/tags/@nuxt/kit@5.0.0', 'ref=refs/tags/release-2024-05-01'])
    })

    it('cuts the release on the coordination tag and dispatches the release set', () => {
      process.env.PR_BODY = 'body'
      main()
      expect(ghCalls().at(-2)).toEqual(['release', 'create', 'release-2024-05-01', '--title', '@nuxt/kit@5.0.0', '--notes', 'body'])
      expect(ghCalls().at(-1)).toEqual([
        'workflow', 'run', 'release.yml', '--ref', 'release-2024-05-01',
        '-f', 'releases=[{"name":"@nuxt/kit","version":"5.0.0","dir":"packages/kit"}]',
      ])
    })

    it('marks the release as a prerelease when every released package is a prerelease', () => {
      writePkg(resolve(root, 'packages/kit'), { name: '@nuxt/kit', version: '5.0.0-beta.0' })
      main()
      expect(ghCalls().at(-2)).toContain('--prerelease')
    })

    it('does not mark the release as a prerelease when a stable package ships alongside', () => {
      writePkg(resolve(root, 'packages/kit'), { name: '@nuxt/kit', version: '5.0.0-beta.0' })
      writePkg(resolve(root, 'packages/ui'), { name: '@nuxt/ui', version: '2.0.1' })
      main()
      expect(ghCalls().at(-2)).not.toContain('--prerelease')
    })

    it('suffixes the coordination tag when the date is taken', () => {
      existingTags = [...existingTags, 'release-2024-05-01']
      main()
      const created = ghCalls().filter(args => args[1] === '-X').map(args => args[7])
      expect(created).toContain('ref=refs/tags/release-2024-05-01.2')
    })

    it('throws when nothing changed', () => {
      existingTags = ['@nuxt/kit@5.0.0', '@nuxt/ui@2.0.0']
      expect(() => main()).toThrow(/nothing to release/)
    })

    it('refuses to run when a package tag already exists remotely', () => {
      existingTags = ['@nuxt/ui@2.0.0']
      execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'for-each-ref') return existingTags.join('\n') + '\n'
        if (cmd === 'git') return 'deadbeef\n'
        if (cmd === 'gh' && args[0] === 'api' && args[1] !== '-X') {
          if (args[args.length - 1]!.endsWith('@nuxt/kit@5.0.0')) return '{"ref":"x"}'
          throw new Error('gh: 404')
        }
        return ''
      })
      expect(() => main()).toThrow(/Refusing to tag: @nuxt\/kit@5\.0\.0 already exists/)
    })

    it('refuses to run when several package tags already exist remotely', () => {
      existingTags = []
      execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'for-each-ref') return ''
        if (cmd === 'git') return 'deadbeef\n'
        if (cmd === 'gh' && args[0] === 'api' && args[1] !== '-X') {
          if (args[args.length - 1]!.includes('release-')) throw new Error('gh: 404')
          return '{"ref":"x"}'
        }
        return ''
      })
      expect(() => main()).toThrow(/already exist on owner\/repo/)
    })

    it('reports which tags were created when tag creation fails midway', () => {
      execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'for-each-ref') return existingTags.join('\n') + '\n'
        if (cmd === 'git') return 'deadbeef\n'
        if (cmd === 'gh' && args[0] === 'api' && args[1] === '-X') {
          if (args[7]!.includes('release-')) throw new Error('gh: 422')
          return ''
        }
        if (cmd === 'gh' && args[0] === 'api') throw new Error('gh: 404')
        return ''
      })
      expect(() => main()).toThrow(/created so far: @nuxt\/kit@5\.0\.0/)
    })

    it('reports an empty created list when the first tag fails', () => {
      execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'for-each-ref') return existingTags.join('\n') + '\n'
        if (cmd === 'git') return 'deadbeef\n'
        if (cmd === 'gh' && args[0] === 'api' && args[1] === '-X') throw new Error('gh: 422')
        if (cmd === 'gh' && args[0] === 'api') throw new Error('gh: 404')
        return ''
      })
      expect(() => main()).toThrow(/created so far: <none>/)
    })

    it('pluralises the summary for multiple packages', () => {
      writePkg(resolve(root, 'packages/ui'), { name: '@nuxt/ui', version: '3.0.0' })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      main()
      expect(log.mock.calls.at(-1)?.[0]).toMatch(/Tagged 2 packages/)
    })
  })
})
