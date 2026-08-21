import { describe, expect, it } from 'vitest'

import type { Workspace } from '../scripts/_workspaces.ts'
import {
  buildDependencyGraph,
  propagateReleases,
  topologicalOrder,
} from '../scripts/_dependency-graph.ts'

function ws (name: string, pkg: Record<string, unknown> = {}): Workspace {
  const full = { name, version: '1.0.0', ...pkg }
  return {
    dir: `/repo/packages/${name}`,
    relDir: `packages/${name}`,
    name,
    version: '1.0.0',
    pkg: full,
    source: JSON.stringify(full, null, 2),
  }
}

describe('buildDependencyGraph', () => {
  it('detects edges across published dependency fields', () => {
    const graph = buildDependencyGraph([
      ws('a'),
      ws('c'),
      ws('d'),
      ws('e', {
        dependencies: { a: 'workspace:*' },
        peerDependencies: { c: 'workspace:*' },
        optionalDependencies: { d: 'workspace:*' },
      }),
    ])
    expect(graph.dependencies.get('e')).toEqual(new Set(['a', 'c', 'd']))
    expect(graph.dependents.get('a')).toEqual(new Set(['e']))
  })

  it('does not create edges from workspace: devDependencies', () => {
    const graph = buildDependencyGraph([
      ws('a'),
      ws('b', { devDependencies: { a: 'workspace:*' } }),
    ])
    expect(graph.dependencies.get('b')).toEqual(new Set())
    expect(graph.dependents.get('a')).toEqual(new Set())
  })

  it('accepts all workspace: specifier flavours and rejects registry specifiers', () => {
    const graph = buildDependencyGraph([
      ws('a'),
      ws('b'),
      ws('c'),
      ws('d'),
      ws('e'),
      ws('consumer', {
        dependencies: {
          a: 'workspace:*',
          b: 'workspace:^',
          c: 'workspace:~',
          d: 'workspace:1.2.3',
          e: '^1.2.3',
        },
      }),
    ])
    expect(graph.dependencies.get('consumer')).toEqual(new Set(['a', 'b', 'c', 'd']))
    expect(graph.dependents.get('e')).toEqual(new Set())
  })

  it('ignores workspace: deps on packages outside the given list', () => {
    const graph = buildDependencyGraph([
      ws('a', { dependencies: { playground: 'workspace:*' } }),
    ])
    expect(graph.dependencies.get('a')).toEqual(new Set())
  })
})

describe('topologicalOrder', () => {
  it('orders a linear chain dependencies-first', () => {
    const graph = buildDependencyGraph([
      ws('c', { dependencies: { b: 'workspace:*' } }),
      ws('b', { dependencies: { a: 'workspace:*' } }),
      ws('a'),
    ])
    expect(topologicalOrder(graph)).toEqual(['a', 'b', 'c'])
  })

  it('orders a diamond dependencies-first', () => {
    const graph = buildDependencyGraph([
      ws('d', { dependencies: { b: 'workspace:*', c: 'workspace:*' } }),
      ws('b', { dependencies: { a: 'workspace:*' } }),
      ws('c', { dependencies: { a: 'workspace:*' } }),
      ws('a'),
    ])
    const order = topologicalOrder(graph)
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))
  })

  it('preserves input order for independent packages', () => {
    const graph = buildDependencyGraph([ws('b'), ws('a'), ws('c')])
    expect(topologicalOrder(graph)).toEqual(['b', 'a', 'c'])
  })

  it('breaks cycles deterministically without throwing', () => {
    const workspaces = [
      ws('a', { dependencies: { b: 'workspace:*' } }),
      ws('b', { dependencies: { a: 'workspace:*' } }),
    ]
    const graph = buildDependencyGraph(workspaces)
    expect(topologicalOrder(graph)).toEqual(['a', 'b'])
    expect(topologicalOrder(buildDependencyGraph([...workspaces].reverse()))).toEqual(['b', 'a'])
  })
})

describe('propagateReleases', () => {
  it('propagates transitively along a linear chain', () => {
    const graph = buildDependencyGraph([
      ws('a'),
      ws('b', { dependencies: { a: 'workspace:*' } }),
      ws('c', { dependencies: { b: 'workspace:*' } }),
    ])
    expect(propagateReleases(graph, [{ name: 'a', bump: 'minor' }])).toEqual([
      { name: 'a', bump: 'minor', ownCommits: true },
      { name: 'b', bump: 'patch', ownCommits: false },
      { name: 'c', bump: 'patch', ownCommits: false },
    ])
  })

  it('is a no-op when nothing depends on the bumped package', () => {
    const graph = buildDependencyGraph([
      ws('a'),
      ws('b', { dependencies: { a: 'workspace:*' } }),
    ])
    expect(propagateReleases(graph, [{ name: 'b', bump: 'patch' }])).toEqual([
      { name: 'b', bump: 'patch', ownCommits: true },
    ])
  })

  it('does not downgrade an existing bump on an incoming propagation', () => {
    const graph = buildDependencyGraph([
      ws('a'),
      ws('b', { dependencies: { a: 'workspace:*' } }),
    ])
    expect(propagateReleases(graph, [
      { name: 'a', bump: 'major' },
      { name: 'b', bump: 'minor' },
    ])).toEqual([
      { name: 'a', bump: 'major', ownCommits: true },
      { name: 'b', bump: 'minor', ownCommits: true },
    ])
  })

  it('does not propagate through a workspace: devDependency', () => {
    const graph = buildDependencyGraph([
      ws('a'),
      ws('b', { devDependencies: { a: 'workspace:*' } }),
    ])
    expect(propagateReleases(graph, [{ name: 'a', bump: 'major' }])).toEqual([
      { name: 'a', bump: 'major', ownCommits: true },
    ])
  })

  it('handles the fontaine shape', () => {
    const graph = buildDependencyGraph([
      ws('fontaine'),
      ws('fontless', { dependencies: { fontaine: 'workspace:*' } }),
    ])
    expect(propagateReleases(graph, [{ name: 'fontaine', bump: 'minor' }])).toEqual([
      { name: 'fontaine', bump: 'minor', ownCommits: true },
      { name: 'fontless', bump: 'patch', ownCommits: false },
    ])
  })
})
