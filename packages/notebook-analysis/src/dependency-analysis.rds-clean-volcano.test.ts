import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from './analysis-test-support'
import { NotebookDependencyAnalyzer } from './analysis-test-support'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { serializedFileContext, type FileGeneration } from './serialized-file-provenance'
import cells from './reported-rds-clean-volcano.fixture.json'

// Owned keys can still dispatch xtfrm; unproven ordering keeps effects partial.
// Known paths and producer/consumer evidence remain checked independently.

it('captures the producer and records ordinary ownership at saveRDS', async () => {
  const { facts } = await analyzeRNotebookSource(cells[7].script)
  expect(facts.serializedValueWrites).toEqual([
    { path: 'diff_df_clean.rds', format: 'rds', valueType: 'r-value' }
  ])
  expect(await analyzeNotebookSourceFileAccess('r', cells[7].script)).toMatchObject({
    readState: 'partial',
    writeState: 'partial',
    reads: ['inputs/differential-results-333333333333.xlsx'],
    writes: ['diff_df_clean.rds']
  })
})

it('requires matching generation evidence for the RDS reader', async () => {
  expect((await analyzeNotebookSourceFileAccess('r', cells[8].script)).externalState).toBe(
    'partial'
  )
  expect(
    await analyzeNotebookSourceFileAccess('r', cells[8].script, {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      verifiedSerializedValues: [{ path: 'diff_df_clean.rds', format: 'rds', valueType: 'r-value' }]
    })
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['diff_df_clean.rds'],
    writes: ['diagonal_volcano.png']
  })
})

const makeRun = (index: number): NotebookRunRecord => ({
  runId: String(index),
  cellId: String(index),
  kernelKind: 'r',
  kernelEpochId: 'epoch',
  environment: 'r',
  source: 'agent',
  status: cells[index].status === 'failed' ? 'failed' : 'completed',
  kernelDispatched: index !== 4,
  startedAt: index,
  endedAt: index + 1,
  script: cells[index].script,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})
const generations = new Map<string, Map<string, FileGeneration[]>>()
const readGenerations =
  (root: string) =>
  async (run: { runId: string }): Promise<FileGeneration[]> =>
    generations.get(root)?.get(run.runId) ?? []
const evidence = async (
  root: string,
  run: NotebookRunRecord,
  relation: 'created' | 'present-before',
  checksum: string
): Promise<void> => {
  if (!generations.has(root)) generations.set(root, new Map())
  generations.get(root)!.set(run.runId, [{ path: 'diff_df_clean.rds', checksum, relation }])
  run.fileEvidence = {
    state: 'available',
    checksum,
    fileReads: 'complete',
    writerAttribution: 'complete'
  }
}

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])(
  'rebuilds RDS evidence with epoch change=%s and proven producer=%s',
  async (newEpoch, provenProducer) => {
    const root = await mkdtemp(join(tmpdir(), 'rds-clean-history-'))
    const runs = cells.map((c) => makeRun(c.index))
    if (provenProducer) runs[7].script = 'df <- data.frame(x=1:3);saveRDS(df,"diff_df_clean.rds")'
    if (newEpoch) runs[8].kernelEpochId = 'new-epoch'
    try {
      await evidence(root, runs[7], 'created', 'a'.repeat(64))
      await evidence(root, runs[8], 'present-before', 'a'.repeat(64))
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        readFileGenerations: readGenerations(root),
        repository: { readSessionRuns: async () => runs }
      })
      const p = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '8' })
      expect(p.stalenessByRunId['8'], JSON.stringify(p)).toMatchObject(
        provenProducer
          ? { state: 'clear' }
          : { state: 'unknown', reasons: expect.arrayContaining(['opaque-call']) }
      )
      expect(p.dependenciesByRunId?.['8']).toEqual(provenProducer ? [] : undefined) // File generations, not memory, connect the cells.
      const reopened = new NotebookDependencyAnalyzer({
        storageRoot: root,
        readFileGenerations: readGenerations(root),
        repository: { readSessionRuns: async () => runs }
      })
      const context = await reopened.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: '8',
        language: 'r',
        environment: 'r',
        kernelEpochId: runs[8].kernelEpochId!
      })
      expect(context?.verifiedSerializedValues ?? []).toEqual(
        provenProducer ? [{ path: 'diff_df_clean.rds', format: 'rds', valueType: 'r-value' }] : []
      )
      if (provenProducer)
        expect(
          (
            await analyzeNotebookSourceFileAccess(
              'r',
              'df <- readRDS("diff_df_clean.rds");head(df)',
              context
            )
          ).externalState
        ).toBe('complete')
      await evidence(root, runs[8], 'present-before', 'b'.repeat(64))
      const changed = await reopened.project({ projectId: 'p', sessionId: 's', throughRunId: '8' })
      expect(changed.stalenessByRunId['8'].state).toBe('unknown')
      const changedContext = await reopened.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: '8',
        language: 'r',
        environment: 'r',
        kernelEpochId: runs[8].kernelEpochId!
      })
      expect(changedContext?.verifiedSerializedValues ?? []).toEqual([])
    } finally {
      generations.delete(root)
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  'd<-new.env(); saveRDS(d,"x.rds")',
  'd<-readRDS("unknown.rds"); saveRDS(d,"x.rds")',
  'd<-data.frame(x=1); saveRDS(d,"x.rds"); saveRDS(new.env(),"x.rds")',
  'd<-data.frame(x=1); saveRDS(d,"x.rds"); file.copy("unknown.rds","x.rds",overwrite=TRUE)',
  'd<-data.frame(x=1); saveRDS(d,"x.rds"); saveRDS(new.env(),"./x.rds")',
  'd<-data.frame(x=1); saveRDS(d,"x.rds"); con<-file("x.rds","wb")',
  'd<-data.frame(x=1); saveRDS(d,"x.rds"); cat("replaced",file="x.rds")',
  'd<-data.frame(x=1); if(flag) saveRDS(d,"x.rds")',
  'd<-data.frame(x=1); saveRDS<-custom; saveRDS(d,"x.rds")'
])('does not certify unknown or replaced serialization: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.serializedValueWrites ?? []).toEqual([])
})

it('does not certify serialization when the caller has no verified generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rds-evidence-integrity-'))
  const run = makeRun(7)
  try {
    await evidence(root, run, 'created', 'a'.repeat(64))
    const { facts } = await analyzeRNotebookSource(run.script)
    generations.get(root)!.delete(run.runId)
    const context = await serializedFileContext(readGenerations(root), [run], () => facts, 'next')
    expect(context?.serializedValueFiles).toBeUndefined()
  } finally {
    generations.delete(root)
    await rm(root, { recursive: true, force: true })
  }
})

// A matching initial generation does not certify a replacement made during the cell.
it('revokes verified ownership after an in-cell overwrite', async () => {
  const { facts } = await analyzeRNotebookSource(
    'saveRDS(new.env(),"./x.rds"); d<-readRDS("x.rds"); saveRDS(d,"next.rds")',
    {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      verifiedSerializedValues: [{ path: 'x.rds', format: 'rds', valueType: 'r-value' }]
    }
  )
  expect(facts.serializedValueWrites ?? []).toEqual([])
})

it.each([false, true])(
  'rebuilds producer evidence before a new epoch with proven producer=%s',
  async (provenProducer) => {
    const root = await mkdtemp(join(tmpdir(), 'rds-new-epoch-'))
    const run = makeRun(7)
    if (provenProducer) run.script = 'df <- data.frame(x=1:3);saveRDS(df,"diff_df_clean.rds")'
    try {
      await evidence(root, run, 'created', 'a'.repeat(64))
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        readFileGenerations: readGenerations(root),
        repository: { readSessionRuns: async () => [run] }
      })
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: 'next',
        language: 'r',
        environment: 'r',
        kernelEpochId: 'new-epoch'
      })
      expect(context?.serializedValueFiles ?? []).toEqual(
        provenProducer
          ? [
              {
                path: 'diff_df_clean.rds',
                format: 'rds',
                valueType: 'r-value',
                checksum: 'a'.repeat(64)
              }
            ]
          : []
      )
      expect(context?.verifiedSerializedValues ?? []).toEqual([])
      expect(context?.rCopyOnModifyNames ?? []).toEqual([])
    } finally {
      generations.delete(root)
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  ['.', false],
  ['results/science', false],
  ['.', true],
  ['results/science', true]
] as const)(
  'uses generation namespace %s with proven producer=%s',
  async (executionRelativeRoot, provenProducer) => {
    const run = makeRun(7)
    if (provenProducer) run.script = 'df <- data.frame(x=1:3);saveRDS(df,"diff_df_clean.rds")'
    run.fileEvidence = { state: 'available', fileReads: 'complete', writerAttribution: 'complete' }
    const path =
      executionRelativeRoot === '.'
        ? 'diff_df_clean.rds'
        : `${executionRelativeRoot}/diff_df_clean.rds`
    const { facts } = await analyzeRNotebookSource(run.script)
    const current = makeRun(8)
    const context = await serializedFileContext(
      async (input) => [
        {
          path,
          checksum: 'same-generation',
          relation: input.runId === run.runId ? 'created' : 'present-before'
        }
      ],
      [run, current],
      () => facts,
      current.runId,
      undefined,
      executionRelativeRoot
    )
    expect(context?.serializedValueFiles?.[0]?.path).toBe(provenProducer ? path : undefined)
    expect(context?.verifiedSerializedValues ?? []).toEqual(
      provenProducer ? [{ path: 'diff_df_clean.rds', format: 'rds', valueType: 'r-value' }] : []
    )
  }
)
