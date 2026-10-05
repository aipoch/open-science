import { createHash } from 'node:crypto'
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

const completedRun = (
  runId: string,
  cellId: string,
  script: string,
  storageRoot: string,
  writes: string[] = []
): NotebookRunRecord => ({
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

describe('Python rasterio dependency corpus', () => {
  it('does not certify VSI or HTTP paths as local GeoTIFF inputs', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        'import rasterio\nsource = rasterio.open("/vsicurl/https://example.org/dem.tif")'
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('downgrades coverage when an unmodeled reader method may mutate the dataset', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        'import rasterio\nsource = rasterio.open("inputs/dem.tif", "r")\nsource.update_tags(processed=True)'
      )
    ).resolves.toMatchObject({
      reads: ['inputs/dem.tif'],
      readState: 'partial'
    })
  })

  it('links a GeoTIFF read, transform, and output verification across cells', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-rasterio-'))
    temporaryRoots.push(storageRoot)
    const scripts = [
      'import rasterio\nsource = rasterio.open("inputs/dem.tif", "r")',
      'elevation = source.read(1)\nprofile = source.profile\nscaled = elevation * 0.001',
      'source.close()',
      'with rasterio.open("outputs/dem-scaled.tif", "w", **profile) as destination:\n    destination.write(scaled, 1)',
      'check = rasterio.open("outputs/dem-scaled.tif", "r")\nprint(check.read(1).shape)'
    ]
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
    for (const [index, script] of scripts.entries()) {
      const run = completedRun(
        `run-${index + 1}`,
        `cell-${index + 1}`,
        script,
        storageRoot,
        index === 3 ? ['outputs/dem-scaled.tif'] : []
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
    expect(projection?.dependenciesByRunId?.['run-4']).toContain('run-2')
    expect(projection?.fileDependenciesByRunId?.['run-5']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ producerRunId: 'run-4', path: 'outputs/dem-scaled.tif' })
      ])
    )
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })
})
