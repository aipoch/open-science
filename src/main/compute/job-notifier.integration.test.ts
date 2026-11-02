import { expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ComputeHost } from '@aipoch/compute'
import { createNotifyingJobPoller } from './job-notifier'

import type { ComputeConnectionBrokerAcquirer } from '@aipoch/compute/node'

import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { harvestJob } from './harvest-engine'
import { emitJobNotification } from './job-notifier'
import type { ComputeHostRepository } from './repository'
import { ComputeJobResultDeliveryAdapter } from '../background-result-delivery/compute-adapter'
import { BackgroundResultDeliveryRepository } from '../background-result-delivery/repository'
import { addRendererBroadcastSink } from '../renderer-broadcast'
import { COMPUTE_JOB_UPDATED_CHANNEL, createJobUpdatedBroadcaster } from './ipc'
import type { JobSummary } from '../../shared/compute'

it.each(['complete', 'failed'] as const)(
  'publishes %s collection after early cancellation delivery without delivering the final result again',
  async (outcome) => {
    const database = await createMigratedComputeTestDatabase('open-science-cancelled-harvest-')
    const updates: JobSummary[] = []
    const remove = addRendererBroadcastSink((channel, payload) => {
      if (channel === COMPUTE_JOB_UPDATED_CHANNEL) updates.push(payload as JobSummary)
    })
    try {
      const { storageRoot, client } = database
      const { jobs, operations } = database.repositories
      const scope = { providerId: 'ssh:cluster', projectId: 'project-1', sessionId: 'session-1' }
      await jobs.create({
        id: 'cancelled-job',
        ...scope,
        shape: 'scheduler_cluster',
        executionMode: 'slurm',
        intent: 'collect partial results',
        command: 'analysis',
        commandHash: 'hash',
        initialStatus: 'running',
        remoteWorkdir: '/scratch/cancelled-job',
        outputManifest: JSON.stringify(['result.csv']),
        allowUnencryptedPersistence: true
      })
      await operations.request('cancelled-job', 'cancel', scope, new Date())
      const claim = await operations.claimNext('cancel', new Date(), 30_000, 'cancel-claim')
      expect(await operations.fulfill(claim!, new Date())).toBe(true)
      const cancelled = (await jobs.get('cancelled-job'))!
      const deliveryRepository = new BackgroundResultDeliveryRepository(async () => client)
      const enqueue = vi.fn((source: Parameters<typeof deliveryRepository.enqueue>[0]) =>
        deliveryRepository.enqueue(source)
      )
      const register = vi.fn((source: Parameters<typeof deliveryRepository.register>[0]) =>
        deliveryRepository.register(source)
      )
      const resultDelivery = new ComputeJobResultDeliveryAdapter({
        register,
        enqueue,
        acknowledgeObserved: async (source) => {
          await deliveryRepository.acknowledgeObserved(source)
          return 'suppressed'
        },
        listWaiting: () => deliveryRepository.listWaiting('compute-job'),
        hasDeliveryPath: (kind, id) => deliveryRepository.hasDeliveryPath(kind, id)
      })
      const host = {
        displayName: 'Cluster',
        sshAlias: 'cluster'
      } as ComputeHost
      const hostRepository = {
        get: vi.fn(async () => (outcome === 'complete' ? host : null))
      } as unknown as ComputeHostRepository
      const notify = vi.fn<(summary: JobSummary) => void>((summary) => {
        void resultDelivery.observeNotification(summary)
      })
      await emitJobNotification(cancelled, {
        jobRepository: jobs,
        hostRepository,
        storageRoot,
        broadcast: notify
      })
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce())
      await resultDelivery.observeResult(notify.mock.calls[0][0])
      expect(await deliveryRepository.find('compute-job:cancelled-job')).toMatchObject({
        state: 'consumed'
      })
      const notifiedAt = (await jobs.get('cancelled-job'))!.notified_at
      expect(notifiedAt).toBeDefined()
      expect(cancelled.harvested_at).toBeUndefined()
      const publishJobUpdated = createJobUpdatedBroadcaster(
        hostRepository,
        storageRoot,
        jobs,
        resultDelivery
      )

      await harvestJob(cancelled, {
        jobRepository: jobs,
        hostRepository,
        storageRoot,
        broadcast: notify,
        publishJobUpdated,
        getFreeDiskBytesFn: async () => 10 * 1024 ** 3,
        connectionBroker: {
          acquire: async () => ({
            run: async (command) => ({
              stdout: command.startsWith('find ')
                ? 'result.csv\t5\t1\t1700000000.0000000000\n'
                : 'f 5 1 1700000000.0000000000',
              stderr: '',
              exitCode: 0,
              timedOut: false,
              truncated: false
            }),
            upload: vi.fn(),
            download: async (_remotePath, localPath) => {
              await mkdir(dirname(localPath), { recursive: true })
              await writeFile(localPath, 'done\n')
              return {
                bytesWritten: 5,
                exceeded: false,
                exitCode: 0,
                stderr: '',
                timedOut: false
              }
            }
          })
        }
      })

      await vi.waitFor(() => expect(updates).toHaveLength(1))
      expect(updates[0]).toMatchObject({
        cancellation_status: 'cancelled',
        result_delivery_path: 'agent-result-delivery',
        notified_at: notifiedAt,
        harvested_at: expect.any(Number),
        featured_file_count: outcome === 'complete' ? 1 : 0
      })
      if (outcome === 'complete') {
        expect(updates[0].featured_files).toEqual(['hpc/cancelled-job/featured/result.csv'])
        expect(updates[0].harvest_error).toBeUndefined()
      } else {
        expect(updates[0].harvest_error).toContain('host not found')
      }
      expect((await jobs.get('cancelled-job'))!.notified_at).toBe(notifiedAt)
      expect(notify).toHaveBeenCalledOnce()
      expect(enqueue).toHaveBeenCalledOnce()
      expect(register).not.toHaveBeenCalled()
      expect(await deliveryRepository.find('compute-job:cancelled-job')).toMatchObject({
        state: 'consumed'
      })
    } finally {
      remove()
      await database.dispose()
    }
  }
)

it('broadcasts once when harvest and recovery notification entrances overlap', async () => {
  const database = await createMigratedComputeTestDatabase('open-science-notifier-overlap-')
  try {
    const { storageRoot } = database
    const jobRepository = database.repositories.jobs
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-overlap',
      providerId: 'ssh:missing-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'notification overlap',
      command: 'true',
      commandHash: 'hash',
      initialStatus: 'success'
    })
    const staleJob = (await jobRepository.get('job-overlap'))!

    let releaseHarvestNotification: (() => void) | undefined
    const harvestNotificationBlocked = new Promise<void>((resolve) => {
      releaseHarvestNotification = resolve
    })
    let harvestNotificationEntered: (() => void) | undefined
    const harvestNotificationStarted = new Promise<void>((resolve) => {
      harvestNotificationEntered = resolve
    })
    let hostLookups = 0
    const hostRepository = {
      get: vi.fn(async () => {
        hostLookups++
        if (hostLookups === 2) {
          harvestNotificationEntered?.()
          await harvestNotificationBlocked
        }
        return null
      })
    } as unknown as ComputeHostRepository
    const broadcast = vi.fn()
    const harvesting = harvestJob(staleJob, {
      connectionBroker: {} as ComputeConnectionBrokerAcquirer,
      hostRepository,
      jobRepository,
      storageRoot,
      broadcast
    })

    await harvestNotificationStarted
    await emitJobNotification(staleJob, {
      jobRepository,
      hostRepository,
      storageRoot,
      broadcast
    })
    releaseHarvestNotification?.()
    await harvesting

    expect((await jobRepository.get('job-overlap'))?.notified_at).toBeDefined()
    expect(broadcast).toHaveBeenCalledOnce()
  } finally {
    await database.dispose()
  }
})

it('recovers a finalized harvest whose notifier claim was interrupted', async () => {
  const database = await createMigratedComputeTestDatabase('open-science-notifier-restart-')
  try {
    const { storageRoot } = database
    const jobRepository = database.repositories.jobs
    await jobRepository.create({
      allowUnencryptedPersistence: true,
      id: 'job-restart-notify',
      providerId: 'ssh:missing-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'restart notification',
      command: 'true',
      commandHash: 'hash'
    })
    await jobRepository.update('job-restart-notify', {
      status: 'success',
      exitCode: 0,
      finishedAt: new Date(),
      harvestedAt: new Date(),
      harvestError: null,
      leftOnRemote: '[]'
    })
    const broadcast = vi.fn()
    await createNotifyingJobPoller({
      connectionBroker: { acquire: vi.fn() } as unknown as ComputeConnectionBrokerAcquirer,
      hostRepository: { get: vi.fn(async () => null) } as unknown as ComputeHostRepository,
      jobRepository,
      storageRoot,
      broadcast
    }).tick()
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce())
    expect((await jobRepository.get('job-restart-notify'))?.notified_at).toBeDefined()
  } finally {
    await database.dispose()
  }
})
