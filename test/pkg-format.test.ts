import { describe, expect, it } from 'vitest'
import { makePkgFormatter } from '../scripts/pkg-format.ts'

describe('makePkgFormatter', () => {
  it('preserves tab indentation and trailing newline', () => {
    const source = '{\n\t"name": "x",\n\t"version": "1.0.0"\n}\n'
    const format = makePkgFormatter(source)
    expect(format(JSON.parse(source))).toBe(source)
  })

  it('preserves 2-space indentation and trailing newline', () => {
    const source = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n'
    const format = makePkgFormatter(source)
    expect(format(JSON.parse(source))).toBe(source)
  })

  it('preserves 4-space indentation', () => {
    const source = '{\n    "name": "x",\n    "version": "1.0.0"\n}'
    const format = makePkgFormatter(source)
    expect(format(JSON.parse(source))).toBe(source)
  })

  it('preserves absence of trailing newline', () => {
    const source = '{\n  "name": "x"\n}'
    const format = makePkgFormatter(source)
    expect(format(JSON.parse(source))).toBe(source)
  })

  it('preserves CRLF line endings throughout', () => {
    const source = '{\r\n  "name": "x",\r\n  "version": "1.0.0"\r\n}\r\n'
    const format = makePkgFormatter(source)
    expect(format(JSON.parse(source))).toBe(source)
  })

  it('falls back to 2-space indent for a minified single-line source', () => {
    const source = '{"name":"x","version":"1.0.0"}'
    const format = makePkgFormatter(source)
    expect(format(JSON.parse(source))).toBe('{\n  "name": "x",\n  "version": "1.0.0"\n}')
  })

  it('applies the detected format when serialising a mutated value', () => {
    const source = '{\n\t"name": "x",\n\t"version": "1.0.0"\n}\n'
    const format = makePkgFormatter(source)
    const pkg = JSON.parse(source)
    pkg.version = '1.1.0'
    expect(format(pkg)).toBe('{\n\t"name": "x",\n\t"version": "1.1.0"\n}\n')
  })
})
