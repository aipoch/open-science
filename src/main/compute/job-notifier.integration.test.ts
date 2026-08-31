import { expect, it, vi } from 'vitest'

import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { harvestJob } from './harvest-engine'
import { emitJobNotification } from './job-notifier'
import { JobPoller } from './job-poller'
import type { ComputeHostRepository } from './repository'

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
    await new JobPoller({
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
