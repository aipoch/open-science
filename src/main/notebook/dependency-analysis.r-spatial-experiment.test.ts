import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const completedRun = (runId: string, script: string): NotebookRunRecord => ({
  runId,
  cellId: runId,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'r',
  kernelEpochId: 'epoch-1',
  environment: 'r',
  script,
  status: 'completed',
  startedAt: Number(runId.slice(-1)),
  endedAt: Number(runId.slice(-1)),
  executionCount: Number(runId.slice(-1)),
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

it('links SpatialExperiment coordinates and Bioconductor transforms across cells', async () => {
  const scripts = [
    'library(SpatialExperiment)\ncounts <- matrix(1:4, nrow = 2)\nspe <- SpatialExperiment(assays = list(counts = counts), spatialCoords = matrix(c(0, 0, 1, 1), ncol = 2))',
    'coords <- SpatialExperiment::spatialCoords(spe)\ncentroid <- colMeans(coords)',
    'spe <- scuttle::logNormCounts(spe, pseudo.count = 1)',
    'embedding <- scater::runPCA(spe, ncomponents = 2)'
  ]
  const entries = await Promise.all(
    scripts.map(async (script, index) => ({
      run: completedRun(`run-${index + 1}`, script),
      facts: (await analyzeRNotebookSource(script)).facts,
      fileAccess: await analyzeNotebookSourceFileAccess('r', script)
    }))
  )
  const projection = projectNotebookDependencies(entries)

  expect(
    entries[0]?.facts.typeSummaries?.some((summary) => summary.name === 'SpatialExperiment')
  ).toBe(true)
  expect(entries[1]?.facts.usedNames).toContain('SpatialExperiment::spatialCoords')
  // A later same-name update invalidates the earlier coordinate snapshot; the
  // projection records that invalidation while retaining the producing run
  // for each subsequent transform.
  expect(projection.stalenessByRunId['run-2']).toMatchObject({
    state: 'stale',
    causedByRunId: 'run-3'
  })
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-4']).toContain('run-3')
  expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(projection.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  expect(projection.stalenessByRunId['run-4']).toMatchObject({
    state: 'clear'
  })
})

it('recognizes SpatialExperiment transforms and marks stochastic reductions uncertain', async () => {
  const { facts } = await analyzeRNotebookSource(
    'library(SpatialExperiment)\ncounts <- matrix(1:4, nrow = 2)\nspe <- SpatialExperiment(assays = list(counts = counts), spatialCoords = matrix(c(0, 0, 1, 1), ncol = 2))\nspe <- scuttle::logNormCounts(spe, pseudo.count = 1)\nspe <- scater::runPCA(spe, ncomponents = 2)'
  )

  expect(facts.state).toBe('unknown')
  const reasons = facts.state === 'unknown' ? facts.reasons : []
  expect(reasons).toContain('external-state')
  expect(facts.safeCallNames).toEqual(
    expect.arrayContaining(['scuttle::logNormCounts', 'scater::runPCA'])
  )
})

it('does not trust a SpatialExperiment constructor from another namespace', async () => {
  const { facts } = await analyzeRNotebookSource(
    'spe <- custom::SpatialExperiment(assays = list(counts = matrix(1:4, nrow = 2)))'
  )

  expect(facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'spe', typeName: 'SpatialExperiment' })
    ])
  )
  expect(facts.state).toBe('unknown')
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})

configureTestRuntimeMetadata()
