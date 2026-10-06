import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const load = (path: string): string => `SeuratDisk::LoadH5Seurat("${path}")`
const save = (path: string): string =>
  `SeuratDisk::SaveH5Seurat(object, filename = "${path}", overwrite = TRUE)`

it('captures SeuratDisk H5Seurat input/output lineage', async () => {
  const source = `object <- ${load('inputs/pbmc.h5seurat')}\n${save('outputs/pbmc-normalized.h5seurat')}`
  const access = await analyzeNotebookSourceFileAccess('r', source)
  expect(access).toEqual({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/pbmc.h5seurat'],
    writes: ['outputs/pbmc-normalized.h5seurat'],
    reasonCodes: []
  })
  const { facts } = await analyzeRNotebookSource(source)
  expect(facts.usedNames ?? []).toContain('SeuratDisk::LoadH5Seurat')
  expect(facts.usedNames ?? []).toContain('SeuratDisk::SaveH5Seurat')
})

it('keeps dynamic SeuratDisk paths partial', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'path <- choose.files(); object <- SeuratDisk::LoadH5Seurat(path)'
  )
  expect(access).toMatchObject({
    readState: 'partial',
    reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
  })
})

it('captures the named filename argument for SeuratDisk inputs', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'object <- SeuratDisk::LoadH5Seurat(filename = "inputs/pbmc.h5seurat")'
  )
  expect(access).toMatchObject({
    readState: 'complete',
    externalState: 'complete',
    reads: ['inputs/pbmc.h5seurat']
  })
})

it('links SeuratDisk serialization across cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seuratdisk-lineage-'))
  const runs: NotebookRunRecord[] = [
    `object <- ${load('inputs/pbmc.h5seurat')}\n${save('work/pbmc.h5seurat')}`,
    `${load('work/pbmc.h5seurat')}\n${save('outputs/pbmc-normalized.h5seurat')}`
  ].map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    script,
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'r',
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    cwdBefore: root,
    cwdAfter: root,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: [
      {
        path: join(root, index === 0 ? 'work/pbmc.h5seurat' : 'outputs/pbmc-normalized.h5seurat'),
        relativePath: index === 0 ? 'work/pbmc.h5seurat' : 'outputs/pbmc-normalized.h5seurat',
        kind: 'other',
        createdByRunId: `run-${index}`,
        change: 'created',
        checksum: String(index).repeat(64)
      }
    ]
  }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({
      projectId: 'project',
      sessionId: 'session',
      completedRun: runs.at(-1)
    })
    expect(projection.fileDependenciesByRunId?.['run-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'work/pbmc.h5seurat', producerRunId: 'run-0' })
      ])
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
