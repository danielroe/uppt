// Workspace dependency graph for the independent-versioning path.
//
// When package A is bumped, any package B that pins A via a
// `workspace:` specifier must also be released, or B's next published
// tarball keeps resolving the previous A. This module builds the graph
// of such edges, orders packages for publishing, and expands a set of
// planned releases to include every affected dependent.

import type { Workspace } from './_workspaces.ts'

// devDependencies are deliberately excluded: `npm pack` strips them, so
// a `workspace:` devDependency can never leave a stale pin in the
// published tarball. Propagating on one would produce a release with no
// user-visible change.
const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

export interface DependencyGraph {
  /** All workspaces, in the order they were given. */
  workspaces: Workspace[]
  /** Package name → names of in-list packages it `workspace:`-depends on. */
  dependencies: Map<string, Set<string>>
  /** Package name → names of in-list packages that `workspace:`-depend on it. */
  dependents: Map<string, Set<string>>
}

/**
 * Build the `workspace:` dependency graph over the given workspaces.
 * An edge B → A exists when B declares A with a `workspace:` specifier
 * in `dependencies`, `peerDependencies`, or `optionalDependencies`.
 * `devDependencies` do not create edges: they are stripped from the
 * published manifest, so they cannot cause a stale pin for consumers. A `workspace:` dependency on a package that
 * is not in `workspaces` (e.g. a private playground excluded from the
 * `packages` input) is ignored.
 */
export function buildDependencyGraph (workspaces: Workspace[]): DependencyGraph {
  const names = new Set(workspaces.map(ws => ws.name))
  const dependencies = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  for (const ws of workspaces) {
    dependencies.set(ws.name, new Set())
    dependents.set(ws.name, new Set())
  }

  for (const ws of workspaces) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = ws.pkg[field]
      if (!deps || typeof deps !== 'object') continue
      for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
        if (!names.has(dep) || dep === ws.name) continue
        dependencies.get(ws.name)!.add(dep)
        dependents.get(dep)!.add(ws.name)
      }
    }
  }

  return { workspaces, dependencies, dependents }
}

/**
 * Order package names so that every dependency comes before the packages
 * that depend on it.
 *
 * This is what lets `propagateReleases` expand the release set in a single
 * pass: a package is visited only once everything it depends on has been
 * considered, so a chain of dependents is picked up without iterating to a
 * fixed point. Publishing does not need the order, since `uppt/publish`
 * stages every version and they go live together on approval.
 *
 * Cycles are unlikely with devDependencies excluded, but are not an error
 * and do not block a release. Tie-break: whenever no package is free of
 * unsatisfied dependencies, the cycle is broken at the member that appears
 * earliest in the input workspace order. Since `resolveWorkspaces` returns
 * a sorted, stable list, the result is deterministic across runs. A broken
 * cycle means one member is ordered before a dependency it pins, which no
 * ordering can avoid; propagation still reaches every member because each
 * is visited once.
 */
export function topologicalOrder (graph: DependencyGraph): string[] {
  const remaining = graph.workspaces.map(ws => ws.name)
  const pending = new Map<string, Set<string>>()
  for (const name of remaining) {
    pending.set(name, new Set(graph.dependencies.get(name)))
  }

  const order: string[] = []
  const placed = new Set<string>()
  while (order.length < remaining.length) {
    let next = remaining.find(name => !placed.has(name) && pending.get(name)!.size === 0)
    next ??= remaining.find(name => !placed.has(name))!
    order.push(next)
    placed.add(next)
    for (const deps of pending.values()) deps.delete(next)
  }
  return order
}

export type BumpLevel = 'major' | 'minor' | 'patch'

export interface PlannedRelease {
  /** Package name. */
  name: string
  /** Bump level for this release. */
  bump: BumpLevel
  /**
   * `true` when the package is released because of its own commits;
   * `false` when it is released only because a `workspace:` dependency
   * was bumped.
   */
  ownCommits: boolean
}

/**
 * Expand a set of planned releases to every dependent that needs a
 * release as a consequence, transitively. A dependent not already
 * being released gets a `patch` bump (the maintainer can escalate in
 * the PR); a dependent already slated keeps its existing bump level.
 * Results are returned in topological (publish) order.
 */
export function propagateReleases (
  graph: DependencyGraph,
  planned: Array<{ name: string, bump: BumpLevel }>,
): PlannedRelease[] {
  const releases = new Map<string, PlannedRelease>()
  for (const { name, bump } of planned) {
    releases.set(name, { name, bump, ownCommits: true })
  }

  const order = topologicalOrder(graph)
  for (const name of order) {
    if (releases.has(name)) continue
    const deps = graph.dependencies.get(name)
    if (!deps) continue
    for (const dep of deps) {
      if (releases.has(dep)) {
        releases.set(name, { name, bump: 'patch', ownCommits: false })
        break
      }
    }
  }

  return order.filter(name => releases.has(name)).map(name => releases.get(name)!)
}
