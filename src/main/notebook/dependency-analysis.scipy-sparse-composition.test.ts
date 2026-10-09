import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { expect, it } from 'vitest'
import { afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

const completedRun = (runId: string, script: string): NotebookRunRecord => ({
  runId,
  cellId: runId,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'python',
  kernelEpochId: 'epoch-1',
  environment: 'default-python',
  script,
  status: 'completed',
  startedAt: 1,
  endedAt: 1,
  executionCount: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

it('keeps sparse composition typed and links it to the published artifact', async () => {
  const source = await analyzePythonNotebookSource(
    'from scipy.sparse import vstack\ncombined = vstack([left, right])'
  )
  expect(source.facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'combined', typeName: 'scipy.sparse.spmatrix' })
    ])
  )

  const scripts = [
    'from scipy.sparse import load_npz\nleft = load_npz("inputs/left.npz")\nright = load_npz("inputs/right.npz")',
    'from scipy.sparse import vstack\ncombined = vstack([left, right])',
    'from scipy.sparse import save_npz\nsave_npz("outputs/combined.npz", combined)'
  ]
  const runs = scripts.map((script, index) => completedRun(`run-${index + 1}`, script))
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-scipy-sparse-composition-'))
  temporaryRoots.push(storageRoot)
  const analyzer = new NotebookDependencyAnalyzer({
    storageRoot,
    repository: { readSessionRuns: async () => runs }
  })
  const projections = []
  for (const run of runs) {
    projections.push(
      await analyzer.project({
        projectId: 'project',
        sessionId: 'session',
        completedRun: run,
        interpreter: { command: 'python' }
      })
    )
  }
  expect(projections.at(1)?.dependenciesByRunId?.['run-2']).toEqual(
    expect.arrayContaining(['run-1'])
  )
  expect(projections.at(2)?.dependenciesByRunId?.['run-3']).toEqual(
    expect.arrayContaining(['run-2'])
  )
})

configureTestRuntimeMetadata()
