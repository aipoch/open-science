import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import { harvestJob } from './harvest-engine'
import { emitJobNotification } from './job-notifier'
import { ComputeJobRepository } from './job-repository'
import { JobPoller } from './job-poller'
import type { ComputeHostRepository } from './repository'

it('broadcasts once when harvest and recovery notification entrances overlap', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notifier-overlap-'))
  const client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
    const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
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
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

it('recovers a finalized harvest whose notifier claim was interrupted', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notifier-restart-'))
  const client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
    const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
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
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
