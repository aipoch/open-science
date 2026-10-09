import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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

it('links MNE Raw FIF extraction, publication, and reload across cells', async () => {
  const scripts = [
    'from mne.io import read_raw_fif\nraw = read_raw_fif("inputs/rest_raw.fif", preload=True)',
    'filtered = raw.copy()',
    'filtered.filter(l_freq=1, h_freq=40)\nsamples = filtered.get_data()\nmean_signal = samples.mean(axis=0)',
    'filtered.save("outputs/rest_filtered_raw.fif", overwrite=True)',
    'from mne.io import read_raw_fif\nreloaded = read_raw_fif("outputs/rest_filtered_raw.fif", preload=False)'
  ]
  const source = await analyzePythonNotebookSource(scripts[0]!)
  expect(source.facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'raw', typeName: 'mne.io.Raw' })])
  )
  const transformed = await analyzePythonNotebookSource(`${scripts[0]}\n${scripts[1]}`)
  expect(transformed.facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'filtered', typeName: 'mne.io.Raw' })
    ])
  )
  await expect(analyzeNotebookSourceFileAccess('python', scripts[0]!)).resolves.toMatchObject({
    readState: 'partial',
    reads: ['inputs/rest_raw.fif']
  })
  await expect(analyzeNotebookSourceFileAccess('python', scripts[3]!)).resolves.toMatchObject({
    writeState: 'partial',
    writes: ['outputs/rest_filtered_raw.fif']
  })
  await expect(analyzeNotebookSourceFileAccess('python', scripts[4]!)).resolves.toMatchObject({
    readState: 'partial',
    reads: ['outputs/rest_filtered_raw.fif']
  })

  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-mne-'))
  temporaryRoots.push(storageRoot)
  const runs: NotebookRunRecord[] = []
  const analyzer = new NotebookDependencyAnalyzer({
    storageRoot,
    repository: { readSessionRuns: async () => runs }
  })
  const projections: Array<Awaited<ReturnType<NotebookDependencyAnalyzer['project']>>> = []
  for (const [index, script] of scripts.entries()) {
    const run = completedRun(
      `run-${index + 1}`,
      script,
      storageRoot,
      index === 3 ? ['outputs/rest_filtered_raw.fif'] : []
    )
    runs.push(run)
    projections.push(
      await analyzer.project({
        projectId: 'project',
        sessionId: 'session',
        completedRun: run,
        interpreter: { command: 'python' }
      })
    )
  }
  expect(projections[1]?.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projections[2]?.dependenciesByRunId?.['run-3']).toContain('run-2')
  expect(projections[3]?.dependenciesByRunId?.['run-4']).toContain('run-3')
  // A FIF can transparently span numbered companion files. A single observed
  // output is therefore kept as an unresolved read until runtime evidence
  // enumerates the complete split set; do not publish a false file edge.
  expect(projections[4]?.fileDependenciesByRunId?.['run-5']).toBeUndefined()
  expect(projections[4]?.unresolvedFileReadRunIds).toContain('run-5')
})

it('keeps dynamic MNE input paths conservative', async () => {
  await expect(
    analyzeNotebookSourceFileAccess(
      'python',
      'from mne.io import read_raw_fif\nraw = read_raw_fif(resolve_raw_path(), preload=True)'
    )
  ).resolves.toMatchObject({
    readState: 'partial',
    reads: [],
    reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
  })
})

configureTestRuntimeMetadata()
