import { describe, expect, it } from 'vitest'

import {
  compareTestPlans,
  createFileTestPlan,
  formatFileTestImpactReport,
  runFileTestImpactCli
} from './file-test-impact.mjs'
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
  'src/main/host-layer-dependencies.architecture.test.ts': "import './owner'",
  'src/main/data/table.json': '{}',
  'src/main/data/notes.md': '# notes'
}
const source = {
  files: new Set(Object.keys(files)),
  read: (path: string) => files[path as keyof typeof files]
}
type Edges = [string, string[]][]
type Plan = ReturnType<typeof createFileTestPlan>
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
const plan = (paths: string[], edges: Edges = [], options: object = {}): Plan =>
  createFileTestPlan(
    paths.map((path) => ({ path, status: 'modified' })),
    { source, reverse: graph(edges), classify, ...options }
  )

describe('createFileTestPlan', () => {
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

  it('runs every test a dynamic reader declares, matched by glob', () => {
    const readers = [
      {
        reason: 'loads data by computed path',
        paths: ['src/main/data/**'],
        tests: ['src/main/*.test.ts'],
        exclude: ['**/*.md']
      }
    ]
    expect(plan(['src/main/data/table.json'], [], { readers }).testFiles).toEqual([
      'src/main/dynamic.test.ts',
      'src/main/host-layer-dependencies.architecture.test.ts',
      'src/main/owner.test.ts',
      'src/main/typed.test.ts'
    ])
    expect(plan(['src/main/data/notes.md'], [], { readers }).testFiles).toEqual([])
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
  it('labels tests the file planner drops by their registered evidence', () => {
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
    expect(result.module).toEqual({ mode: 'selective', tests: 3 })
    expect(result.file).toEqual({ mode: 'selective', tests: 2 })
    expect(
      compareTestPlans(
        { mode: 'full', testFiles: [] },
        { mode: 'selective', testFiles: ['a.test.ts'], unresolved: [] },
        manifest
      )
    ).toMatchObject({ status: 'not-comparable', missing: [], extra: [] })
  })
})

describe('formatFileTestImpactReport', () => {
  const report = {
    status: 'compared',
    module: { mode: 'selective', tests: 3 },
    file: { mode: 'selective', tests: 2 },
    missing: [{ test: 'b.test.ts', evidence: ['owner:consumer'] }],
    extra: ['d.test.ts'],
    unresolved: []
  }

  it('summarizes both planners and lists the differences', () => {
    const markdown = formatFileTestImpactReport(report)
    expect(markdown).toContain('| Module (runs today) | selective | 3 |')
    expect(markdown).toContain('| File (shadow) | selective | 2 |')
    expect(markdown).toContain('### Selected only by the module planner (1)')
    expect(markdown).toContain('- `b.test.ts` — owner:consumer')
    expect(markdown).toContain('- `d.test.ts`')
    expect(markdown).not.toContain('absent from the head snapshot')
  })

  it('truncates long lists and explains full plans', () => {
    const extra = Array.from({ length: 30 }, (_, index) => `t${index}.test.ts`)
    expect(formatFileTestImpactReport({ ...report, extra })).toContain('… 5 more in the artifact')
    expect(
      formatFileTestImpactReport({
        ...report,
        status: 'not-comparable',
        module: { mode: 'full', tests: 0 }
      })
    ).toContain('Not comparable')
  })
})

// workingTreeGraph() is the default for compareRevisionRange so that both planners
// see the same checkout (the merge commit on pull_request, HEAD locally). Its
// integration contract is covered by compareRevisionRange in pr-gate-workflow tests
// and local compareRecentCommits runs; the unit fixture uses an in-memory snapshot.

describe('runFileTestImpactCli', () => {
  it('rejects unknown commands and missing revisions', async () => {
    await expect(runFileTestImpactCli(['nope'])).rejects.toThrow('Unknown file test-impact command')
    await expect(runFileTestImpactCli(['compare', '--base', 'x'])).rejects.toThrow(
      '--base and --head are required'
    )
    await expect(
      runFileTestImpactCli(['compare', '--base', 'x', '--head', 'y', '--tier', 'nightly'])
    ).rejects.toThrow('--tier must be pr or queue')
  })
})
