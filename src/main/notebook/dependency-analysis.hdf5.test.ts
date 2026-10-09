import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzePythonSources } from './dependency-analysis-python'
import { pythonLibraryMethodEffect } from './python-library-effects'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

const completedRun = (runId: string, cellId: string, script: string): NotebookRunRecord => ({
  runId,
  cellId,
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

describe('Python HDF5 dependency corpus', () => {
  it('does not certify remote HDF5 URLs as local file inputs', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        'import h5py\nsource = h5py.File("https://example.org/counts.h5", "r")'
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('links an h5py dataset read to a downstream normalized HDF5 writer', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-hdf5-'))
    temporaryRoots.push(storageRoot)
    const scripts = [
      [
        'import h5py',
        'source = h5py.File("inputs/counts.h5", "r")',
        'matrix = source["counts"][:, :]',
        'sample_ids = source["sample_ids"][:]',
        'source.close()',
        'print(matrix.shape, sample_ids.shape)'
      ].join('\n'),
      [
        'import h5py',
        'normalized = matrix / matrix.sum(axis=0, keepdims=True)',
        'result = h5py.File("outputs/normalized.h5", "w")',
        'result.create_dataset("counts", data=normalized)',
        'result.close()'
      ].join('\n')
    ]
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
    for (const [index, script] of scripts.entries()) {
      const run = {
        ...completedRun(`run-${index + 1}`, `cell-${index + 1}`, script),
        startedAt: index + 1,
        endedAt: index + 1,
        executionCount: index + 1
      }
      runs.push(run)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun: run,
        interpreter: { command: 'unused-python' }
      })
    }
    expect(projection?.dependenciesByRunId?.['run-2']).toEqual(['run-1'])
    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('classifies multidimensional h5py selections as arrays across cells', async () => {
    const [first, second] = await analyzePythonSources([
      [
        'import h5py',
        'source = h5py.File("inputs/counts.h5", "r")',
        'matrix = source["counts"][:, :]',
        'matrix'
      ].join('\n'),
      'normalized = matrix / 2\nprint(normalized.shape)'
    ])
    expect(first?.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'matrix', typeName: 'numpy.ndarray' })
      ])
    )
    expect(second?.usedNames ?? []).toContain('matrix')
  })

  it('models h5py read_direct as a read with destination uncertainty', async () => {
    const [facts] = await analyzePythonSources([
      [
        'import h5py',
        'import numpy as np',
        'source = h5py.File("inputs/counts.h5", "r")',
        'dataset = source["counts"]',
        'buffer = np.empty((2, 2))',
        'dataset.read_direct(buffer)'
      ].join('\n')
    ])
    expect(facts?.receiverCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          receiver: 'dataset',
          member: 'read_direct',
          positionalArgumentNames: [['buffer']]
        })
      ])
    )
    expect(facts?.mutatedNames ?? []).not.toContain('dataset')
    expect(pythonLibraryMethodEffect('h5py.Dataset', 'read_direct')).toMatchObject({
      effect: 'read',
      possiblyMutatesFirstArgument: true
    })
  })
})

configureTestRuntimeMetadata()
