import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { serializedFileContext } from './serialized-file-provenance'
import cells from './reported-rds-clean-volcano.fixture.json'

it('captures the producer and records ordinary ownership at saveRDS', async () => {
  const { facts } = await analyzeRNotebookSource(cells[7].script)
  expect(facts.serializedValueWrites).toEqual([
    { path: 'diff_df_clean.rds', format: 'rds', valueType: 'r-value' }
  ])
  expect(await analyzeNotebookSourceFileAccess('r', cells[7].script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
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
const evidence = async (
  root: string,
  run: NotebookRunRecord,
  relation: 'created' | 'present-before',
  checksum: string
): Promise<void> => {
  const storageKey = `evidence/${run.runId}/evidence.json`
  const value = {
    schemaVersion: 1,
    evidenceId: `evidence-${run.runId}`,
    activityId: run.runId,
    activityKind: 'notebook-run',
    relations: [
      {
        relation,
        relativePath: 'data/diff_df_clean.rds',
        generation: { relativePath: 'data/diff_df_clean.rds', checksum }
      }
    ]
  }
  const json = JSON.stringify(value)
  await mkdir(join(root, 'evidence', run.runId), { recursive: true })
  await writeFile(join(root, storageKey), json)
  run.fileEvidence = {
    schemaVersion: 1,
    activityId: run.runId,
    activityKind: 'notebook-run',
    evidenceId: value.evidenceId,
    checksum: createHash('sha256').update(json).digest('hex'),
    storageKey,
    state: 'available',
    initialViewState: 'complete',
    managedRootsFinalState: 'complete',
    scientificOutputAnalysis: 'complete',
    scientificOutputCount: 0,
    fileReads: 'complete',
    externalPaths: 'complete',
    writerAttribution: 'complete',
    reasonCodes: []
  }
}

it.each([false, true])(
  'rebuilds captured RDS ownership across cells (new epoch=%s)',
  async (newEpoch) => {
    const root = await mkdtemp(join(tmpdir(), 'rds-clean-history-'))
    const runs = cells.map((c) => makeRun(c.index))
    if (newEpoch) runs[8].kernelEpochId = 'new-epoch'
    try {
      await evidence(root, runs[7], 'created', 'a'.repeat(64))
      await evidence(root, runs[8], 'present-before', 'a'.repeat(64))
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const p = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '8' })
      expect(p.stalenessByRunId['8'], JSON.stringify(p)).toEqual({ state: 'clear' })
      expect(p.dependenciesByRunId?.['8']).toEqual([]) // File generations, not memory, connect the cells.
      const reopened = new NotebookDependencyAnalyzer({
        storageRoot: root,
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
      expect(context?.verifiedSerializedValues).toEqual([
        { path: 'diff_df_clean.rds', format: 'rds', valueType: 'r-value' }
      ])
      expect(
        (await analyzeNotebookSourceFileAccess('r', runs[8].script, context)).externalState
      ).toBe('complete')
      await evidence(root, runs[8], 'present-before', 'b'.repeat(64))
      const changed = await reopened.project({ projectId: 'p', sessionId: 's', throughRunId: '8' })
      expect(changed.stalenessByRunId['8'].state).toBe('unknown')
    } finally {
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

it('does not trust missing or tampered evidence manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rds-evidence-integrity-'))
  const run = makeRun(7)
  try {
    await evidence(root, run, 'created', 'a'.repeat(64))
    const { facts } = await analyzeRNotebookSource(run.script)
    await writeFile(join(root, run.fileEvidence!.storageKey!), '{}')
    const context = await serializedFileContext(root, [run], () => facts, 'next')
    expect(context?.serializedValueFiles).toBeUndefined()
  } finally {
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

it('rebuilds producer evidence before the first live read in a new R epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rds-new-epoch-'))
  const run = makeRun(7)
  try {
    await evidence(root, run, 'created', 'a'.repeat(64))
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
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
    expect(context?.serializedValueFiles).toEqual([
      {
        path: 'data/diff_df_clean.rds',
        format: 'rds',
        valueType: 'r-value',
        checksum: 'a'.repeat(64)
      }
    ])
    expect(context?.verifiedSerializedValues).toEqual([])
    expect(context?.rCopyOnModifyNames ?? []).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
