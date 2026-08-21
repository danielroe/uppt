import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))

const { main } = await import('../scripts/pack.ts')

const PACK_ENV = ['GITHUB_REF', 'RELEASES', 'PACK_OUT_DIR', 'PACKAGES', 'GITHUB_OUTPUT'] as const

let env: NodeJS.ProcessEnv
let cwd: string
let root: string
let outDir: string

function writePkg (dir: string, pkg: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(pkg))
}

/** Make the mocked pack tool emit `filename` and drop a matching tarball in `outDir`. */
function packsAs (...filenames: string[]) {
  let i = 0
  execFileSync.mockImplementation(() => {
    const filename = filenames[Math.min(i++, filenames.length - 1)]!
    writeFileSync(resolve(outDir, filename), 'tarball')
    return `{"name":"pkg","filename":"${filename}"}\n`
  })
}

beforeEach(() => {
  env = { ...process.env }
  cwd = process.cwd()
  for (const key of PACK_ENV) delete process.env[key]
  root = mkdtempSync(resolve(tmpdir(), 'uppt-pack-'))
  outDir = resolve(root, 'out')
  process.env.PACK_OUT_DIR = outDir
  process.env.GITHUB_REF = 'refs/tags/v1.2.3'
  writePkg(root, { name: 'root-pkg', version: '1.2.3' })
  process.chdir(root)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  process.chdir(cwd)
  process.env = env
  execFileSync.mockReset()
  vi.restoreAllMocks()
})

describe('pack', () => {
  it('rejects a ref that is not a semver tag', () => {
    process.env.GITHUB_REF = 'refs/heads/main'
    expect(() => main()).toThrow(/must be a strict-semver/)
  })

  it('reports an unset ref', () => {
    delete process.env.GITHUB_REF
    expect(() => main()).toThrow(/got '<unset>'/)
  })

  it('requires PACK_OUT_DIR', () => {
    delete process.env.PACK_OUT_DIR
    expect(() => main()).toThrow('PACK_OUT_DIR is required')
  })

  it('packs the repo root with npm when there is no pnpm lockfile', () => {
    packsAs('root-pkg-1.2.3.tgz')
    main()
    expect(execFileSync).toHaveBeenCalledTimes(1)
    const [cmd, args] = execFileSync.mock.calls[0]!
    expect(cmd).toBe('npm')
    expect(args).toEqual(['pack', '--pack-destination', outDir, '--json', '--silent'])
  })

  it('packs with pnpm when a pnpm lockfile is present', () => {
    writeFileSync(resolve(root, 'pnpm-lock.yaml'), '')
    packsAs('root-pkg-1.2.3.tgz')
    main()
    const [cmd, args] = execFileSync.mock.calls[0]!
    expect(cmd).toBe('pnpm')
    expect(args).toEqual(['pack', '--pack-destination', outDir, '--json'])
  })

  it('packs each declared workspace', () => {
    writePkg(resolve(root, 'packages/a'), { name: 'a', version: '1.2.3' })
    writePkg(resolve(root, 'packages/b'), { name: 'b', version: '1.2.3' })
    process.env.PACKAGES = 'packages/*'
    packsAs('a-1.2.3.tgz', 'b-1.2.3.tgz')
    main()
    expect(execFileSync.mock.calls.map(call => call[2].cwd)).toEqual([
      resolve(root, 'packages/a'),
      resolve(root, 'packages/b'),
    ])
  })

  it('writes the packed filenames to GITHUB_OUTPUT', () => {
    const outputFile = resolve(root, 'gh-output')
    writeFileSync(outputFile, '')
    process.env.GITHUB_OUTPUT = outputFile
    packsAs('root-pkg-1.2.3.tgz')
    main()
    expect(readFileSync(outputFile, 'utf8')).toBe('files=["root-pkg-1.2.3.tgz"]\n')
  })

  it('throws when the pack tool reports a tarball it did not write', () => {
    execFileSync.mockReturnValue('{"name":"pkg","filename":"ghost-1.2.3.tgz"}\n')
    expect(() => main()).toThrow(/is not present in/)
  })

  it('throws when two workspaces produce the same tarball name', () => {
    writePkg(resolve(root, 'packages/a'), { name: 'a', version: '1.2.3' })
    writePkg(resolve(root, 'packages/b'), { name: 'b', version: '1.2.3' })
    process.env.PACKAGES = 'packages/*'
    packsAs('a-1.2.3.tgz')
    expect(() => main()).toThrow(/duplicate tarball/)
  })

  describe('independent mode', () => {
    beforeEach(() => {
      process.env.GITHUB_REF = 'refs/tags/release-2024-05-01'
      writePkg(resolve(root, 'packages/kit'), { name: '@nuxt/kit', version: '5.0.0' })
      process.env.RELEASES = JSON.stringify([{ name: '@nuxt/kit', version: '5.0.0', dir: 'packages/kit' }])
    })

    it('packs exactly the dispatched workspaces', () => {
      packsAs('nuxt-kit-5.0.0.tgz')
      main()
      expect(execFileSync.mock.calls[0]![2].cwd).toBe(resolve(root, 'packages/kit'))
    })

    it('requires a coordination tag', () => {
      process.env.GITHUB_REF = 'refs/tags/v1.2.3'
      expect(() => main()).toThrow(/coordination tag/)
    })

    it('reports an unset ref', () => {
      delete process.env.GITHUB_REF
      expect(() => main()).toThrow(/got '<unset>'/)
    })

    it('throws when an entry points at a directory with no package.json', () => {
      process.env.RELEASES = JSON.stringify([{ name: '@nuxt/kit', version: '5.0.0', dir: 'packages/gone' }])
      expect(() => main()).toThrow(/has no package.json/)
    })

    it('throws when an entry points at a private package', () => {
      writePkg(resolve(root, 'packages/kit'), { name: '@nuxt/kit', version: '5.0.0', private: true })
      expect(() => main()).toThrow(/private package/)
    })

    it('throws when an entry does not match the package.json on disk', () => {
      writePkg(resolve(root, 'packages/kit'), { name: '@nuxt/kit', version: '4.0.0' })
      expect(() => main()).toThrow(/does not match/)
    })
  })
})
