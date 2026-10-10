import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
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

describe('netCDF4 multi-cell lineage', { timeout: 60_000 }, () => {
  it('does not certify remote OPeNDAP stores as local file inputs', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        'from netCDF4 import Dataset\ndataset = Dataset("https://example.org/data.nc")'
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('tracks Dataset handles across cells and preserves dependencies after replacement', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-netcdf-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'from netCDF4 import Dataset\ndataset = Dataset("climate.nc", mode="r")',
      'snapshot = dataset\nprint(snapshot.filepath())',
      'dataset = Dataset("updated-climate.nc", mode="r")',
      'print(dataset.filepath())'
    ]
    let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
    for (const [index, script] of scripts.entries()) {
      const run = completedRun(`run-${index + 1}`, `cell-${index + 1}`, script)
      runs.push(run)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun: run,
        interpreter: { command: 'unused-python' }
      })
    }
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.dependenciesByRunId?.['run-2']).toEqual(expect.arrayContaining(['run-1']))
    expect(projection?.dependenciesByRunId?.['run-4']).toEqual(expect.arrayContaining(['run-3']))
  })
})

configureTestRuntimeMetadata()
