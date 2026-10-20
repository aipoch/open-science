import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputeExecution, type ComputeConnectionLease } from '@aipoch/compute/node'
import type { ComputeHostRepository } from '@aipoch/compute'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeJobRepository } from './job-repository'
import { describe, expect, it, vi } from 'vitest'

import {
  createDeletionRuntimeHarness,
  deletionCases
} from './job-deletion-runtime-isolation.test-support'

describe('Compute Job deletion runtime drain boundary', () => {
  it.each([
    ['remote cleanup planning', 'planning'],
    ['remote cleanup', 'cleanup']
  ] as const)('keeps another Session polling while %s is in flight', async (_label, phase) => {
    const isPlanning = phase === 'planning'
    const sessionDeletion = deletionCases[0]
    const harness = await createDeletionRuntimeHarness(sessionDeletion, {
      holdCleanupPlanning: isPlanning,
      holdRemoteCleanup: !isPlanning
    })
    try {
      const deletion = harness.deleteOwner()
      if (isPlanning) void deletion.catch(() => undefined)
      await (isPlanning ? harness.cleanupPlanningStarted : harness.cleanupStarted)
      if (!isPlanning) expect(harness.authorityCommitted()).toBe(true)

      await harness.runScheduledPoll()
      await expect(harness.survivorStatus()).resolves.toMatchObject({
        status: 'success',
        exit_code: 0
      })

      if (isPlanning) harness.releaseCleanupPlanning()
      else harness.releaseRemoteCleanup()
      await expect(deletion).rejects.toThrow('The Compute Host could not be reached.')
    } finally {
      await harness.dispose()
    }
  })
})

describe('persisted pre-launch owner cleanup', () => {
  it.skipIf(process.platform === 'win32').each(['.open-science', '.openscience'])(
    'removes rows only after safe absent %s cleanup and releases the barrier',
    async (directory) => {
      const root = await mkdtemp(join(tmpdir(), 'compute-owner-absent-'))
      const client = createProjectDbClient(root)
      try {
        await migrateApplicationDatabase(client)
        const repository = new ComputeJobRepository(() => Promise.resolve(client))
        const createRequest = {
          id: 'failed-job',
          providerId: 'ssh:cluster',
          shape: 'direct_ssh' as const,
          projectId: 'project-1',
          sessionId: 'session-1',
          intent: 'pre-launch failure',
          command: 'true',
          commandHash: 'hash',
          remoteWorkdir: join(root, directory, 'jobs', 'failed-job'),
          initialStatus: 'submitted' as const,
          allowUnencryptedPersistence: true
        }
        await repository.create(createRequest)
        await repository.update('failed-job', { status: 'error', errorCode: 'dispatch_failed' })
        let cleanupCompleted = false
        const queueManager = { pauseOwner: vi.fn(async () => undefined), resumeOwner: vi.fn() }
        const owner = createComputeExecution().createDeletionOwner({
          jobRepository: repository,
          queueManager,
          hostRepository: {
            get: async () => ({
              id: 'host-1',
              providerId: 'ssh:cluster',
              displayName: 'Cluster',
              shape: 'direct_ssh',
              sshAlias: 'cluster',
              sshOverrides: undefined,
              concurrencyLimit: undefined,
              probeResult: undefined,
              detailsUpdatedAt: undefined,
              detailsUpdatedBy: undefined,
              scratchRoot: root,
              scratchPinned: false,
              detailsDoc: '',
              createdAt: 1,
              updatedAt: 1
            })
          } satisfies Pick<ComputeHostRepository, 'get'>,
          connectionBroker: {
            acquire: async () =>
              ({
                run: async (command: string) => {
                  expect(await repository.get('failed-job')).not.toBeNull()
                  await expect(
                    repository.create({ ...createRequest, id: 'blocked' })
                  ).rejects.toThrow(/owner is being deleted/)
                  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
                  cleanupCompleted = result.status === 0
                  return {
                    exitCode: result.status ?? 1,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    truncated: false,
                    timedOut: false
                  }
                },
                upload: async () => undefined,
                download: async () => ({
                  exitCode: 0,
                  stderr: '',
                  timedOut: false,
                  bytesWritten: 0,
                  exceeded: false
                })
              }) satisfies ComputeConnectionLease
          }
        })
        await owner.prepareSessionJobDeletion('project-1', 'session-1')
        expect(await repository.get('failed-job')).not.toBeNull()
        await owner.commitSessionJobDeletion('project-1', 'session-1')
        expect(cleanupCompleted).toBe(true)
        expect(await repository.get('failed-job')).toBeNull()
        await expect(repository.create({ ...createRequest, id: 'after-deletion' })).rejects.toThrow(
          /owner is being deleted/
        )
        expect(queueManager.resumeOwner).toHaveBeenCalledWith({
          projectId: 'project-1',
          sessionId: 'session-1'
        })
        await owner.abortSessionJobDeletion('project-1', 'session-1')
        await expect(
          repository.create({ ...createRequest, id: 'after-explicit-release' })
        ).resolves.toBeDefined()
      } finally {
        await client.$disconnect()
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
