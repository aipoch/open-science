import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { readNotebookFileGenerations } from './analysis-file-evidence'
import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'
import type { NotebookAnalysisRun } from '@aipoch/notebook-analysis'

const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
type EvidenceFixture = {
  runId: string
  fileEvidence: NonNullable<NotebookAnalysisRun['fileEvidence']> & {
    activityId: string
    activityKind: string
    evidenceId: string
    storageKey: string
    checksum: string
  }
}
const writeEvidence = async (
  root: string,
  runId: string,
  relation = 'created'
): Promise<EvidenceFixture> => {
  const value = {
    schemaVersion: 1,
    evidenceId: `evidence-${runId}`,
    activityKind: 'notebook-run',
    activityId: runId,
    relations: [
      {
        relativePath: 'data/table.rds',
        relation,
        generation: { relativePath: 'data/table.rds', checksum: 'a'.repeat(64) }
      }
    ]
  }
  const storageKey = `evidence/${runId}/evidence.json`
  await mkdir(join(root, 'evidence', runId), { recursive: true })
  const bytes = JSON.stringify(value)
  await writeFile(join(root, storageKey), bytes)
  return {
    runId,
    fileEvidence: {
      state: 'available' as const,
      writerAttribution: 'complete' as const,
      fileReads: 'complete' as const,
      activityId: runId,
      activityKind: 'notebook-run',
      evidenceId: value.evidenceId,
      storageKey,
      checksum: digest(bytes)
    }
  }
}

it.each(['tampered', 'missing', 'budget', 'identity', 'schema', 'outside-root'])(
  'rejects %s host evidence without certifying a file generation',
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-evidence-'))
    try {
      const run = await writeEvidence(root, 'writer')
      const path = join(root, run.fileEvidence.storageKey)
      if (failure === 'tampered') await writeFile(path, '{}')
      if (failure === 'missing') await rm(path)
      if (failure === 'identity') run.runId = 'different-run'
      if (failure === 'schema') {
        const bytes = JSON.stringify({
          schemaVersion: 2,
          activityId: run.runId,
          activityKind: 'notebook-run',
          evidenceId: run.fileEvidence.evidenceId,
          relations: []
        })
        await writeFile(path, bytes)
        run.fileEvidence.checksum = digest(bytes)
      }
      if (failure === 'outside-root') {
        await mkdir(join(root, 'authorized'))
        await symlink(
          join(root, 'evidence'),
          join(root, 'authorized', 'evidence'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }
      expect(
        await readNotebookFileGenerations(
          failure === 'outside-root' ? join(root, 'authorized') : root,
          run,
          { remaining: failure === 'budget' ? 0 : 1024 * 1024 }
        )
      ).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('adapts existing manifests and data paths into analysis across a cache restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-evidence-restart-'))
  try {
    const writer = await writeEvidence(root, 'writer')
    const reader = await writeEvidence(root, 'reader', 'present-before')
    const runs: NotebookAnalysisRun[] = [
      {
        ...writer,
        cellId: 'writer',
        kernelKind: 'r',
        status: 'completed',
        kernelEpochId: 'old',
        environment: 'r',
        script: 'd <- data.frame(x=1); saveRDS(d,"table.rds")',
        workingFiles: []
      },
      {
        ...reader,
        cellId: 'reader',
        kernelKind: 'r',
        status: 'completed',
        kernelEpochId: 'new',
        environment: 'r',
        script: 'd <- readRDS("table.rds")',
        workingFiles: []
      }
    ]
    const options = { storageRoot: root, repository: { readSessionRuns: async () => runs } }
    await createNotebookDependencyAnalyzer(options).project({ projectId: 'p', sessionId: 's' })
    const context = await createNotebookDependencyAnalyzer(options).sourceFileAccessContext({
      projectId: 'p',
      sessionId: 's',
      currentRunId: 'reader',
      language: 'r',
      environment: 'r',
      kernelEpochId: 'new'
    })
    expect(context?.serializedValueFiles).toEqual([
      { path: 'data/table.rds', format: 'rds', valueType: 'r-value', checksum: 'a'.repeat(64) }
    ])
    expect(context?.verifiedSerializedValues).toEqual([
      { path: 'table.rds', format: 'rds', valueType: 'r-value' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

configureTestRuntimeMetadata()
