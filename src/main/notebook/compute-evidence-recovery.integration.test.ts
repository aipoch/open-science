import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  beginComputeJobFileEvidence,
  publishComputeJobFileEvidence,
  reconcileComputeJobFileEvidence,
  runEvidenceWorker,
  startWorkingFileObservation
} from './working-file-observer'

type Job = Parameters<typeof reconcileComputeJobFileEvidence>[1][number]
const projectId = 'project-batch'
const sharedBytes = 'shared immutable scientific input\n'
let storageRoot: string

const sessionRoot = (sessionId: string): string =>
  join(storageRoot, 'execution-file-evidence', projectId, sessionId)

const setup = async (): Promise<void> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'os-compute-batch-recovery-'))
  await writeFile(join(storageRoot, 'input.csv'), sharedBytes)
}

const begin = async (sessionId: string, jobId: string): Promise<Job> => {
  await beginComputeJobFileEvidence({
    storageRoot,
    projectId,
    sessionId,
    jobId,
    producerRunId: 'run-producer',
    inputs: [
      { localPath: join(storageRoot, 'input.csv'), dstFilename: 'input.csv', label: 'input.csv' }
    ]
  })
  return {
    project_id: projectId,
    session_id: sessionId,
    job_id: jobId,
    producer_run_id: 'run-producer',
    status: 'running',
    submitted_at: 1,
    harvested_at: undefined
  }
}

const publish = async (sessionId: string, jobId: string): Promise<Job> => {
  const job = await begin(sessionId, jobId)
  return {
    ...job,
    status: 'success',
    harvested_at: 2,
    file_evidence: await publishComputeJobFileEvidence({
      storageRoot,
      projectId,
      sessionId,
      jobId,
      producerRunId: 'run-producer',
      outputs: []
    })
  }
}

const readEvidence = async (job: Job): Promise<Buffer> =>
  readFile(join(storageRoot, job.file_evidence!.storageKey!))

const expectSharedBlob = async (job: Job): Promise<void> => {
  const sidecar = JSON.parse((await readEvidence(job)).toString()) as {
    relations: Array<{ generation?: { contentStorageKey: string } }>
  }
  const keys = sidecar.relations.flatMap(({ generation }) =>
    generation ? [generation.contentStorageKey] : []
  )
  expect(keys.length).toBeGreaterThan(0)
  for (const key of keys) {
    expect(await readFile(join(storageRoot, key), 'utf8')).toBe(sharedBytes)
  }
  expect(
    createHash('sha256')
      .update(await readEvidence(job))
      .digest('hex')
  ).toBe(job.file_evidence!.checksum)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

describe('Compute evidence Project batch recovery with the real worker', () => {
  it('retains committed, live, and Notebook evidence while reclaiming abandoned captures across Sessions', async () => {
    await setup()
    const committed = await publish('session-committed', 'job-committed')
    const live = await begin('session-live', 'job-live')
    await begin('session-orphan', 'job-orphan')
    await writeFile(join(storageRoot, 'input.csv'), 'uncommitted orphan bytes')
    await publish('session-uncommitted', 'job-uncommitted')
    await writeFile(join(storageRoot, 'input.csv'), sharedBytes)
    const cancelled = await begin('session-cancelled', 'job-cancelled')
    cancelled.cancellation_status = 'cancelled'
    cancelled.submitted_at = undefined
    const harvested = await begin('session-harvested', 'job-harvested')
    harvested.status = 'success'
    harvested.harvested_at = 2

    const notebookRoot = join(storageRoot, 'notebook')
    const dataRoot = join(notebookRoot, 'data')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(dataRoot, 'input.csv'), sharedBytes)
    const observation = await startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: notebookRoot,
        runId: 'run-notebook',
        fileEvidenceStorageRoot: storageRoot,
        fileEvidenceRoot: sessionRoot('session-notebook'),
        fileEvidenceStoragePrefix: `execution-file-evidence/${projectId}/session-notebook`
      },
      {
        watchDirectory: () => {
          throw Object.assign(new Error('watch unavailable'), { code: 'ENOSPC' })
        }
      }
    )
    const notebook = await observation.finish()
    const notebookPath = join(storageRoot, notebook.fileEvidence.storageKey!)
    const notebookBytes = await readFile(notebookPath)
    const committedBytes = await readEvidence(committed)
    const liveCapturePath = join(sessionRoot(live.session_id), 'staging-job-live', 'capture.json')
    const liveCapture = await readFile(liveCapturePath)
    const jobs = [committed, live, cancelled, harvested]
    const worker = vi.fn(runEvidenceWorker)

    expect(await reconcileComputeJobFileEvidence(storageRoot, jobs, worker)).toEqual({
      removedStagingEntries: 3,
      removedActivityEntries: 1
    })
    expect(worker).toHaveBeenCalledTimes(1)
    expect(worker.mock.calls[0][1]).toMatchObject({
      operation: 'reconcile-compute-project',
      projectName: projectId,
      sessions: expect.arrayContaining([
        expect.objectContaining({ sessionName: 'session-orphan' }),
        expect.objectContaining({ sessionName: 'session-live', deferredActivityIds: ['job-live'] })
      ])
    })
    for (const name of ['orphan', 'uncommitted', 'cancelled', 'harvested']) {
      expect(await readdir(sessionRoot(`session-${name}`))).toEqual([])
    }
    expect(await readdir(sessionRoot(committed.session_id))).not.toContain(
      'receipt-job-committed.json'
    )
    expect(await readFile(liveCapturePath)).toEqual(liveCapture)
    expect(await readFile(notebookPath)).toEqual(notebookBytes)
    expect(await readdir(sessionRoot('session-notebook'))).toContain('receipt-run-notebook.json')
    expect(await readEvidence(committed)).toEqual(committedBytes)
    await expectSharedBlob(committed)
    expect(
      await readdir(join(storageRoot, 'execution-file-evidence', projectId, 'blobs'))
    ).toHaveLength(1)

    expect(await reconcileComputeJobFileEvidence(storageRoot, jobs)).toEqual({
      removedStagingEntries: 0,
      removedActivityEntries: 0
    })
    expect(await readFile(liveCapturePath)).toEqual(liveCapture)
    expect(await readFile(notebookPath)).toEqual(notebookBytes)
    expect(await readEvidence(committed)).toEqual(committedBytes)
    await expectSharedBlob(committed)
  })

  it('preserves a later batch shared blob when the first batch removes its other owner', async () => {
    await setup()
    const orphan = await begin('session-first', 'job-orphan')
    orphan.status = 'error'
    const committed = await publish('session-last', 'job-retained')
    const jobs: Job[] = [
      orphan,
      ...Array.from({ length: 63 }, (_, index): Job => ({
        project_id: projectId,
        session_id: `session-padding-${index}`,
        job_id: `job-padding-${index}`,
        status: 'running',
        submitted_at: 1,
        harvested_at: undefined
      })),
      committed
    ]
    let completedBatches = 0
    const worker: typeof runEvidenceWorker = async (...args) => {
      const result = await runEvidenceWorker(...args)
      completedBatches++
      if (completedBatches === 1) {
        expect(await readdir(sessionRoot('session-first'))).toEqual([])
        expect(await readdir(sessionRoot('session-last'))).toContain('receipt-job-retained.json')
        await expectSharedBlob(committed)
      }
      return result
    }
    expect(await reconcileComputeJobFileEvidence(storageRoot, jobs, worker)).toEqual({
      removedStagingEntries: 1,
      removedActivityEntries: 0
    })
    expect(completedBatches).toBe(2)
    await expectSharedBlob(committed)
    expect(await readdir(sessionRoot('session-last'))).not.toContain('receipt-job-retained.json')
  })

  it('fails closed on a later corrupt receipt and safely retries after earlier receipt settlement', async () => {
    await setup()
    const committed = await publish('session-first', 'job-retained')
    const bad = await begin('session-later', 'job-bad')
    bad.status = 'error'
    const receiptPath = join(sessionRoot(bad.session_id), 'receipt-job-bad.json')
    const validReceipt = await readFile(receiptPath)
    const outsidePath = join(storageRoot, 'outside', 'keep.txt')
    await mkdir(join(storageRoot, 'outside'))
    await writeFile(outsidePath, 'outside data')
    // An unsafe target in the later Session must not be acted on, even after an earlier
    // Session was successfully reconciled in this same worker process.
    const corrupt = { ...JSON.parse(validReceipt.toString()), stagingName: '../../outside' }
    await writeFile(receiptPath, JSON.stringify(corrupt))
    const committedBytes = await readEvidence(committed)

    await expect(reconcileComputeJobFileEvidence(storageRoot, [committed, bad])).rejects.toThrow()
    expect(await readdir(sessionRoot(committed.session_id))).not.toContain(
      'receipt-job-retained.json'
    )
    expect(await readFile(outsidePath, 'utf8')).toBe('outside data')
    expect(await readFile(receiptPath, 'utf8')).toBe(JSON.stringify(corrupt))
    expect(await readEvidence(committed)).toEqual(committedBytes)
    await expectSharedBlob(committed)

    await writeFile(receiptPath, validReceipt)
    expect(await reconcileComputeJobFileEvidence(storageRoot, [committed, bad])).toEqual({
      removedStagingEntries: 1,
      removedActivityEntries: 0
    })
    expect(await readdir(sessionRoot(bad.session_id))).toEqual([])
    expect(await readEvidence(committed)).toEqual(committedBytes)
    await expectSharedBlob(committed)
    expect(await readFile(outsidePath, 'utf8')).toBe('outside data')
    expect(await reconcileComputeJobFileEvidence(storageRoot, [committed, bad])).toEqual({
      removedStagingEntries: 0,
      removedActivityEntries: 0
    })
  })

  it.each(['missing-ownership', 'deleting-project', 'blob-symlink'] as const)(
    'refuses cleanup with %s and leaves retained and orphan evidence recoverable',
    async (state) => {
      await setup()
      const committed = await publish('session-first', 'job-retained')
      await begin('session-orphan', 'job-orphan')
      const root = join(storageRoot, 'execution-file-evidence')
      const ownershipPath = join(root, `.project-ownership-${projectId}.json`)
      const ownershipBytes = await readFile(ownershipPath)
      const orphanPath = join(sessionRoot('session-orphan'), 'receipt-job-orphan.json')
      const orphanBytes = await readFile(orphanPath)
      const committedBytes = await readEvidence(committed)
      const outside = join(storageRoot, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'keep.txt'), 'unrelated user data')
      const blobs = join(root, projectId, 'blobs')
      const savedBlobs = join(storageRoot, 'saved-blobs')
      if (state === 'missing-ownership') await rm(ownershipPath)
      if (state === 'deleting-project') {
        const receipt = JSON.parse(ownershipBytes.toString())
        await writeFile(
          ownershipPath,
          JSON.stringify({
            ...receipt,
            phase: 'deleting',
            tombstoneName: `deleting-${receipt.ownershipToken}`
          })
        )
      }
      if (state === 'blob-symlink') {
        await rename(blobs, savedBlobs)
        await symlink(outside, blobs, process.platform === 'win32' ? 'junction' : 'dir')
      }
      await expect(reconcileComputeJobFileEvidence(storageRoot, [committed])).rejects.toThrow()
      expect(await readEvidence(committed)).toEqual(committedBytes)
      expect(await readFile(orphanPath)).toEqual(orphanBytes)
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('unrelated user data')
      await writeFile(ownershipPath, ownershipBytes)
      if (state === 'blob-symlink') {
        await unlink(blobs)
        await rename(savedBlobs, blobs)
      }
      await reconcileComputeJobFileEvidence(storageRoot, [committed])
      expect(await readdir(sessionRoot('session-orphan'))).toEqual([])
      await expectSharedBlob(committed)
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('unrelated user data')
    }
  )

  it.each(['before', 'after'] as const)(
    'recovers after the worker exits abruptly %s orphan receipt removal',
    async (exitPoint) => {
      await setup()
      const committed = await publish('session-first', 'job-retained')
      await writeFile(join(storageRoot, 'input.csv'), 'orphan-only bytes')
      const orphan = await publish('session-later', 'job-orphan')
      const blobRoot = join(storageRoot, 'execution-file-evidence', projectId, 'blobs')
      expect(await readdir(blobRoot)).toHaveLength(2)
      const committedBytes = await readEvidence(committed)
      const preload = join(storageRoot, 'crash-preload.cjs')
      const marker = join(storageRoot, 'crash-reached.txt')
      // Fault injection exists only in the child preload. Production worker code is untouched.
      await writeFile(
        preload,
        `const fs = require('node:fs');
const original = fs.rmSync;
fs.rmSync = function (path, options) {
  if (String(path) === 'receipt-job-orphan.json') {
    if (${JSON.stringify(exitPoint)} === 'after') original.call(this, path, options);
    fs.writeFileSync(${JSON.stringify(marker)}, 'interrupted receipt removal');
    process.exit(91);
  }
  return original.call(this, path, options);
};\n`
      )
      const originalNodeOptions = process.env.NODE_OPTIONS
      vi.stubEnv(
        'NODE_OPTIONS',
        `${originalNodeOptions ?? ''} --require ${JSON.stringify(preload)}`
      )
      try {
        await expect(reconcileComputeJobFileEvidence(storageRoot, [committed])).rejects.toThrow()
      } finally {
        vi.unstubAllEnvs()
      }
      expect(await readFile(marker, 'utf8')).toBe('interrupted receipt removal')
      expect(await readdir(sessionRoot(committed.session_id))).not.toContain(
        'receipt-job-retained.json'
      )
      expect(await readdir(sessionRoot(orphan.session_id))).not.toContain('activity-job-orphan')
      expect(
        (await readdir(sessionRoot(orphan.session_id))).includes('receipt-job-orphan.json')
      ).toBe(exitPoint === 'before')
      expect(await readEvidence(committed)).toEqual(committedBytes)
      await expectSharedBlob(committed)

      await reconcileComputeJobFileEvidence(storageRoot, [committed])
      expect(await readdir(sessionRoot(orphan.session_id))).toEqual([])
      expect(await readdir(blobRoot)).toHaveLength(1)
      expect(await readEvidence(committed)).toEqual(committedBytes)
      await expectSharedBlob(committed)
      expect(await reconcileComputeJobFileEvidence(storageRoot, [committed])).toEqual({
        removedStagingEntries: 0,
        removedActivityEntries: 0
      })
    }
  )
})
