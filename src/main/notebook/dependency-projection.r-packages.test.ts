import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookEnvironmentManifest, NotebookRunRecord } from '../../shared/notebook'
import type { NotebookExecutionContext } from '../../shared/notebook-execution-context'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'

type RPackages = NonNullable<NotebookExecutionContext['rPackages']>
const packages = (
  before: string[],
  after = before,
  reads: Array<{ name: string; package: string }> = []
): RPackages => ({
  before,
  after,
  reads,
  complete: true
})
const run = (
  index: number,
  script: string,
  state: ReturnType<typeof packages>,
  epoch = 'epoch'
): NotebookRunRecord => ({
  runId: `run-${index}`,
  cellId: `cell-${index}`,
  source: 'agent',
  kernelKind: 'r',
  kernelEpochId: epoch,
  environment: 'default-r',
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index + 1,
  kernelDispatched: true,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: [],
  environmentManifest: manifest(state)
})
const manifest = (state: ReturnType<typeof packages>): NotebookEnvironmentManifest => {
  const observation = { locale: 'C', timezone: 'UTC', threadLimits: {}, randomLibraries: [] }
  const executionContext = {
    schemaVersion: 1 as const,
    before: observation,
    after: observation,
    rPackages: state
  }
  return {
    schemaVersion: 1,
    captureKind: 'completed-run',
    capturedAt: '2026-09-09T00:00:00Z',
    installedInventory: {
      capturedAt: '2026-09-09T00:00:00Z',
      source: 'full-scan',
      validation: 'full-scan'
    },
    kernelKind: 'r',
    environmentName: 'default-r',
    runtimeSource: 'managed',
    inventorySources: ['kernel-native'],
    packages: [],
    complete: true,
    captureStatus: 'complete',
    executionContext
  }
}
const project = async (runs: NotebookRunRecord[]): Promise<NotebookDependencyProjection> =>
  projectNotebookDependencies(
    await Promise.all(
      runs.map(async (run) => ({ run, facts: (await analyzeRNotebookSource(run.script)).facts }))
    )
  )

it('does not certify unknown extension function effects from package capture alone', async () => {
  const result = await project([
    run(0, 'library(splines)', packages([], ['splines'])),
    run(
      1,
      'basis <- ns(1:10, df=3)',
      packages(['splines'], ['splines'], [{ name: 'ns', package: 'splines' }])
    )
  ])
  // Resolving a package binding does not prove arbitrary function side effects safe.
  expect(result.stalenessByRunId['run-1']?.state).toBe('unknown')
})

it('reports the exact missing loader instead of treating an attached package as a replay start', async () => {
  const result = await project([
    run(
      0,
      'df <- read_excel("input.xlsx")',
      packages(['readxl'], ['readxl'], [{ name: 'read_excel', package: 'readxl' }])
    )
  ])
  expect(result.stalenessByRunId['run-0']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['missing-package-load:readxl'])
  })
})

it('does not reuse package setup from a previous kernel epoch', async () => {
  const result = await project([
    run(0, 'library(readxl)', packages([], ['readxl']), 'old'),
    run(
      1,
      'df <- read_excel("input.xlsx")',
      packages(['readxl'], ['readxl'], [{ name: 'read_excel', package: 'readxl' }]),
      'new'
    )
  ])
  expect(result.dependenciesByRunId?.['run-1']).toBeUndefined()
  expect(result.stalenessByRunId['run-1']?.state).toBe('unknown')
})

it('keeps a locally loaded package independent of missing earlier history', async () => {
  const result = await project([
    run(
      0,
      'library(readxl); df <- read_excel("input.xlsx")',
      packages(['readxl'], ['readxl'], [{ name: 'read_excel', package: 'readxl' }])
    )
  ])
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it('retains the captured loader and data producer for a cross-cell result', async () => {
  const result = await project([
    run(0, 'library(RColorBrewer)', packages([], ['RColorBrewer'])),
    run(1, 'n <- 3', packages(['RColorBrewer'])),
    run(
      2,
      'colors <- brewer.pal(n, "Set1")',
      packages(
        ['RColorBrewer'],
        ['RColorBrewer'],
        [{ name: 'brewer.pal', package: 'RColorBrewer' }]
      )
    )
  ])
  expect(result.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-2']).toEqual(['run-0', 'run-1'])
})

it('does not reuse an older loader after an unrecorded detach and reattach', async () => {
  const result = await project([
    run(0, 'library(readxl)', packages([], ['readxl'])),
    run(1, 'x <- 1', packages([], [])),
    run(
      2,
      'df <- read_excel("input.xlsx")',
      packages(['readxl'], ['readxl'], [{ name: 'read_excel', package: 'readxl' }])
    )
  ])
  expect(result.stalenessByRunId['run-2']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['missing-package-load:readxl'])
  })
})

it('does not certify truncated package evidence', async () => {
  const result = await project([run(0, 'x <- 1', { ...packages([]), complete: false })])
  expect(result.stalenessByRunId['run-0']).toMatchObject({
    state: 'unknown',
    reasons: ['package-binding-capture-incomplete']
  })
})

it('invalidates cached projections when package evidence changes without a source edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r-package-projection-cache-'))
  const record = run(0, 'df <- read_excel("input.xlsx")', packages([]))
  const options = { storageRoot: root, repository: { readSessionRuns: async () => [record] } }
  const request = { projectId: 'p', sessionId: 's', completedRun: record }
  try {
    const analyzer = new NotebookDependencyAnalyzer(options)
    expect((await analyzer.project(request)).stalenessByRunId['run-0']?.state).toBe('clear')
    record.environmentManifest = manifest(
      packages(['readxl'], ['readxl'], [{ name: 'read_excel', package: 'readxl' }])
    )
    for (const instance of [analyzer, new NotebookDependencyAnalyzer(options)]) {
      expect((await instance.project(request)).stalenessByRunId['run-0']).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['missing-package-load:readxl'])
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('recognizes explicit heatmap package setup even when the package was already attached', async () => {
  const result = await project([
    run(
      0,
      'suppressPackageStartupMessages({library(pheatmap);library(RColorBrewer)})\npheatmap(matrix(1:4,2),filename="heatmap.png")',
      packages(
        ['pheatmap', 'RColorBrewer'],
        ['pheatmap', 'RColorBrewer'],
        [{ name: 'pheatmap', package: 'pheatmap' }]
      )
    )
  ])
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})
