import { describe, expect, it } from 'vitest'

import { compareTestPlans, createDagTestPlan } from './dag-test-plan.mjs'
import { consumerDependencyGraph } from './module-graph/index.mjs'

const files = {
  'src/shared/locale.ts': 'export const LOCALES = []',
  'src/shared/i18n/core.ts': "import { LOCALES } from '../locale'",
  'src/renderer/src/i18n/index.ts': "import '../../../shared/i18n/core'",
  'src/renderer/src/i18n/resources.test.ts': "import './index'",
  'src/renderer/src/pages/Page.tsx': "import '../i18n'",
  'src/renderer/src/pages/Page.test.tsx': "import './Page'",
  'src/renderer/src/pages/Page.i18n.render.test.tsx': "import './Page'",
  'src/main/owner.ts': "import { LOCALES } from '../shared/locale'",
  'src/main/owner.test.ts': "import './owner'",
  'src/main/typed.test.ts': "import type { Value } from './owner'",
  'src/main/dynamic.test.ts': 'loadByName(name)',
  'src/main/host-layer-dependencies.architecture.test.ts': "import './owner'"
}
const source = {
  files: new Set(Object.keys(files)),
  read: (path: string) => files[path as keyof typeof files]
}
type Edges = [string, string[]][]
type Plan = ReturnType<typeof createDagTestPlan>
const graph = (edges: Edges = []): Map<string, Set<string>> =>
  consumerDependencyGraph(source, edges).reverse
const classify = (
  changes: { path: string }[]
): {
  mode: string
  roots: string[]
  lanes: string[]
  bundles: string[]
  reasonChains: string[]
} => ({
  mode: changes.some(({ path }) => path === 'package.json') ? 'full' : 'selective',
  roots: changes.every(({ path }) => path.startsWith('scripts/ci/module-impact/'))
    ? ['module_registration']
    : [],
  lanes: [],
  bundles: ['unit'],
  reasonChains: []
})
const plan = (paths: string[], edges: Edges = []): Plan =>
  createDagTestPlan(
    paths.map((path) => ({ path, status: 'modified' })),
    { source, reverse: graph(edges), classify }
  )

describe('createDagTestPlan', () => {
  it('selects runtime-reachable tests and ignores type-only importers', () => {
    expect(plan(['src/main/owner.ts']).testFiles).toEqual([
      'src/main/host-layer-dependencies.architecture.test.ts',
      'src/main/owner.test.ts'
    ])
  })

  it('follows declared dynamic edges', () => {
    expect(
      plan(['src/main/owner.ts'], [['src/main/owner.ts', ['src/main/dynamic.test.ts']]]).testFiles
    ).toEqual([
      'src/main/dynamic.test.ts',
      'src/main/host-layer-dependencies.architecture.test.ts',
      'src/main/owner.test.ts'
    ])
  })

  it('stops at the i18n boundary and runs only its suites', () => {
    expect(plan(['src/renderer/src/i18n/index.ts']).testFiles).toEqual([
      'src/main/host-layer-dependencies.architecture.test.ts',
      'src/renderer/src/i18n/resources.test.ts',
      'src/renderer/src/pages/Page.i18n.render.test.tsx'
    ])
  })

  it('does not leak through the boundary from an upstream contract', () => {
    expect(plan(['src/shared/locale.ts']).testFiles).toEqual([
      'src/main/host-layer-dependencies.architecture.test.ts',
      'src/main/owner.test.ts',
      'src/renderer/src/i18n/resources.test.ts',
      'src/renderer/src/pages/Page.i18n.render.test.tsx'
    ])
  })

  it('keeps ordinary consumers selective outside the boundary', () => {
    expect(plan(['src/renderer/src/pages/Page.tsx']).testFiles).toEqual([
      'src/main/host-layer-dependencies.architecture.test.ts',
      'src/renderer/src/pages/Page.i18n.render.test.tsx',
      'src/renderer/src/pages/Page.test.tsx'
    ])
  })

  it('runs source-reader tests when a production file in the glob changes', () => {
    expect(plan(['src/main/owner.ts']).testFiles).toContain(
      'src/main/host-layer-dependencies.architecture.test.ts'
    )
    expect(plan(['src/main/owner.test.ts']).testFiles).not.toContain(
      'src/main/host-layer-dependencies.architecture.test.ts'
    )
  })

  it('never selects tests from registration data', () => {
    expect(plan(['scripts/ci/module-impact/owner.json', 'src/main/owner.ts']).testFiles).toEqual([
      'src/main/host-layer-dependencies.architecture.test.ts',
      'src/main/owner.test.ts'
    ])
  })

  it('defers to classifier full plans and records paths absent from the snapshot', () => {
    expect(plan(['package.json']).mode).toBe('full')
    expect(plan(['src/main/removed.ts']).unresolved).toEqual(['src/main/removed.ts'])
  })
})

describe('compareTestPlans', () => {
  it('labels tests the DAG drops by their registered evidence', () => {
    const manifest = {
      modules: {
        owner: {
          testFiles: { owner: ['a.test.ts'], contract: [], consumer: ['b.test.ts', 'c.test.ts'] },
          derivedConsumerTests: ['c.test.ts']
        }
      }
    }
    const result = compareTestPlans(
      { mode: 'selective', modules: ['owner'], testFiles: ['a.test.ts', 'b.test.ts', 'c.test.ts'] },
      { mode: 'selective', testFiles: ['a.test.ts', 'd.test.ts'], unresolved: [] },
      manifest
    )
    expect(result.missing).toEqual([
      { test: 'b.test.ts', evidence: ['owner:consumer'] },
      { test: 'c.test.ts', evidence: ['owner:derived'] }
    ])
    expect(result.extra).toEqual(['d.test.ts'])
    expect(
      compareTestPlans({ mode: 'full', testFiles: [] }, result as never, manifest).status
    ).toBe('not-comparable')
  })
})
