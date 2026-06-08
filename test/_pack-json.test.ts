import { describe, expect, it } from 'vitest'
import { extractTrailingJson, parseFilenames } from '../scripts/_pack-json.ts'

describe('extractTrailingJson', () => {
  it('parses a bare pnpm-style object', () => {
    const stdout = '{"name":"x","filename":"/abs/x-1.0.0.tgz"}\n'
    expect(extractTrailingJson(stdout)).toEqual({ name: 'x', filename: '/abs/x-1.0.0.tgz' })
  })

  it('parses a bare npm-style array', () => {
    const stdout = '[{"filename":"x-1.0.0.tgz"}]\n'
    expect(extractTrailingJson(stdout)).toEqual([{ filename: 'x-1.0.0.tgz' }])
  })

  it('strips leading lifecycle script output before pnpm JSON', () => {
    const stdout = [
      '> x@1.0.0 prepare',
      '> simple-git-hooks && pnpm build',
      '',
      '> x@1.0.0 build',
      '> unbuild',
      '',
      '[INFO] Successfully built dist/index.mjs',
      '[INFO] Successfully built dist/index.cjs',
      '{"name":"x","filename":"/abs/x-1.0.0.tgz"}',
    ].join('\n') + '\n'
    expect(extractTrailingJson(stdout)).toEqual({ name: 'x', filename: '/abs/x-1.0.0.tgz' })
  })

  it('strips leading lifecycle script output before npm JSON', () => {
    const stdout = [
      '> x@1.0.0 prepare',
      '> tsc',
      '',
      '[',
      '  {"filename": "x-1.0.0.tgz"}',
      ']',
    ].join('\n') + '\n'
    expect(extractTrailingJson(stdout)).toEqual([{ filename: 'x-1.0.0.tgz' }])
  })

  it('handles pretty-printed pnpm JSON', () => {
    const stdout = [
      '[INFO] noise',
      '{',
      '  "name": "x",',
      '  "filename": "/abs/x-1.0.0.tgz"',
      '}',
    ].join('\n')
    expect(extractTrailingJson(stdout)).toEqual({ name: 'x', filename: '/abs/x-1.0.0.tgz' })
  })

  it('prefers the last JSON value when lifecycle output itself contained JSON', () => {
    const stdout = [
      '{"some":"json a tool printed during prepare"}',
      '[INFO] more noise',
      '{"name":"x","filename":"/abs/x-1.0.0.tgz"}',
    ].join('\n') + '\n'
    expect(extractTrailingJson(stdout)).toEqual({ name: 'x', filename: '/abs/x-1.0.0.tgz' })
  })

  it('throws when stdout is empty', () => {
    expect(() => extractTrailingJson('   \n')).toThrow(/no output/)
  })

  it('throws when stdout does not end with a JSON value', () => {
    expect(() => extractTrailingJson('[INFO] only logs here\n')).toThrow(/did not end with a JSON value/)
  })
})

describe('parseFilenames', () => {
  it('normalises pnpm absolute filenames to basenames', () => {
    const stdout = [
      '[INFO] Successfully built dist/index.mjs',
      '{"name":"x","filename":"/tmp/uppt-pack/x-1.0.0.tgz"}',
    ].join('\n') + '\n'
    expect(parseFilenames(stdout)).toEqual(['x-1.0.0.tgz'])
  })

  it('returns npm array filenames unchanged when already basenames', () => {
    const stdout = '[{"filename":"x-1.0.0.tgz"},{"filename":"y-1.0.0.tgz"}]\n'
    expect(parseFilenames(stdout)).toEqual(['x-1.0.0.tgz', 'y-1.0.0.tgz'])
  })

  it('throws when the JSON entry is missing a filename', () => {
    expect(() => parseFilenames('{"name":"x"}\n')).toThrow(/without 'filename'/)
  })

  it('throws when filename is not a .tgz', () => {
    expect(() => parseFilenames('{"filename":"x-1.0.0.zip"}\n')).toThrow(/Unexpected pack JSON 'filename'/)
  })

  it('throws when no filenames are produced', () => {
    expect(() => parseFilenames('[]\n')).toThrow(/no tarball filenames/)
  })
})
