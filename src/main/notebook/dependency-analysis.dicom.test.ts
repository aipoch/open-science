import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzePythonNotebookSource, analyzePythonSources } from './dependency-analysis-python'
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

describe('DICOM multi-cell lineage', { timeout: 60_000 }, () => {
  it('captures keyword DICOM input and Dataset.save_as output', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'import pydicom\nscan = pydicom.dcmread(fp="inputs/ct.dcm")\nscan.save_as("outputs/ct.dcm")'
    )
    expect(access).toMatchObject({ reads: ['inputs/ct.dcm'], writes: ['outputs/ct.dcm'] })
  })

  it('tracks DICOM pixels through normalization and a later DICOM file consumer', async () => {
    const pixelFacts = await analyzePythonNotebookSource(
      'import pydicom\nscan = pydicom.dcmread("inputs/ct.dcm")\npixels = scan.pixel_array\nnormalized = pixels.astype("float32")'
    )
    expect(pixelFacts.facts.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'scan', typeName: 'pydicom.Dataset' }),
        expect.objectContaining({ target: 'pixels', typeName: 'numpy.ndarray' }),
        expect.objectContaining({ target: 'normalized', typeName: 'numpy.ndarray' })
      ])
    )
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-dicom-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'import pydicom\nscan = pydicom.dcmread("inputs/ct.dcm")',
      'pixels = scan.pixel_array.astype("float32")\nnormalized = pixels / pixels.max()',
      'scan.save_as("work/ct-copy.dcm")',
      'copied = pydicom.dcmread("work/ct-copy.dcm")\nprint(copied.Rows, normalized.mean())'
    ]
    let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
    for (const [index, script] of scripts.entries()) {
      const run = completedRun(
        `run-${index + 1}`,
        script,
        storageRoot,
        index === 2 ? ['work/ct-copy.dcm'] : []
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
    expect(projection?.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(projection?.fileDependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining([expect.objectContaining({ producerRunId: 'run-3' })])
    )
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('links a SimpleITK series reader across discovery and execution cells', async () => {
    const [facts] = await analyzePythonSources([
      'import SimpleITK as sitk\nfiles = sitk.ImageSeriesReader.GetGDCMSeriesFileNames("inputs/dicom-series")\nreader = sitk.ImageSeriesReader()\nreader.SetFileNames(files)\nimage = reader.Execute()\narray = sitk.GetArrayFromImage(image)'
    ])
    expect(facts.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'image', typeName: 'SimpleITK.Image' }),
        expect.objectContaining({ target: 'array', typeName: 'numpy.ndarray' })
      ])
    )

    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-simpleitk-series-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'import SimpleITK as sitk\nfiles = sitk.ImageSeriesReader.GetGDCMSeriesFileNames("inputs/dicom-series")\nreader = sitk.ImageSeriesReader()\nreader.SetFileNames(files)',
      'image = reader.Execute()\narray = sitk.GetArrayFromImage(image)'
    ]
    let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
    for (const [index, script] of scripts.entries()) {
      const run = {
        ...completedRun(`run-${index + 1}`, script, storageRoot),
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
    expect(projection?.dependenciesByRunId?.['run-2']).toContain('run-1')
  })
})

configureTestRuntimeMetadata()
