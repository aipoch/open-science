import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

const completedRun = (
  runId: string,
  script: string,
  storageRoot: string,
  writes: string[] = []
): NotebookRunRecord => ({
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
  workingFiles: writes.map((relativePath) => ({
    path: join(storageRoot, relativePath),
    relativePath,
    kind: 'other' as const,
    createdByRunId: runId,
    change: 'created' as const,
    checksum: createHash('sha256').update(`${runId}:${relativePath}`).digest('hex')
  })),
  inputFiles: [],
  cwdBefore: storageRoot,
  cwdAfter: storageRoot
})

describe('SciPy sparse multi-cell lineage', { timeout: 60_000 }, () => {
  it('captures Matrix Market and NPZ sparse input/output paths', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'from scipy.io import mmread\nfrom scipy.sparse import save_npz\nmatrix = mmread("inputs/counts.mtx")\nsave_npz("outputs/counts.npz", matrix)'
    )
    expect(access).toMatchObject({ reads: ['inputs/counts.mtx'], writes: ['outputs/counts.npz'] })
  })

  it('links sparse matrix loading, normalization, publication, and reload across cells', async () => {
    const source = await analyzePythonNotebookSource(
      'from scipy.sparse import load_npz\nmatrix = load_npz("inputs/counts.npz")\nnormalized = matrix.astype("float32")'
    )
    expect(source.facts.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'matrix', typeName: 'scipy.sparse.spmatrix' }),
        expect.objectContaining({ target: 'normalized', typeName: 'scipy.sparse.spmatrix' })
      ])
    )

    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-scipy-sparse-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'from scipy.sparse import load_npz\nmatrix = load_npz("inputs/counts.npz")',
      'normalized = matrix.astype("float32")\nnormalized = normalized.multiply(scale)',
      'from scipy.sparse import save_npz\nsave_npz("outputs/normalized", normalized)',
      'reloaded = load_npz("outputs/normalized.npz")\nprint(reloaded.shape)'
    ]
    let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
    for (const [index, script] of scripts.entries()) {
      const run = completedRun(
        `run-${index + 1}`,
        script,
        storageRoot,
        index === 2 ? ['outputs/normalized.npz'] : []
      )
      runs.push(run)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun: run,
        interpreter: { command: 'unused-python' }
      })
    }
    expect(projection?.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(projection?.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(projection?.fileDependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ producerRunId: 'run-3', path: 'outputs/normalized.npz' })
      ])
    )
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })
})
