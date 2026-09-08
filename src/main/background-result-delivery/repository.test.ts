import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BackgroundResultSourceRef } from '../../shared/background-result-delivery'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { BackgroundResultDeliveryRepository } from './repository'

const localRun = (sourceId: string): BackgroundResultSourceRef => ({
  sourceKind: 'local-run',
  sourceId,
  projectId: 'project-1',
  sessionId: 'session-1',
  agentFrameId: 'frame-1'
})

describe('BackgroundResultDeliveryRepository', () => {
  let root: string
  let client: PrismaClient
  let repository: BackgroundResultDeliveryRepository

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'background-result-delivery-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    repository = new BackgroundResultDeliveryRepository(() => Promise.resolve(client))
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  it('settles a local admission and terminal enqueue race as one pending fact', async () => {
    const source = localRun('run-race')

    await Promise.all([repository.register(source), repository.enqueue(source)])

    await expect(repository.find('local-run:run-race')).resolves.toMatchObject({
      ...source,
      state: 'pending'
    })
    await expect(repository.listWaiting('local-run')).resolves.toEqual([])
  })

  it('does not invent a Compute Job delivery without prior admission', async () => {
    const source: BackgroundResultSourceRef = {
      sourceKind: 'compute-job',
      sourceId: 'job-missing',
      projectId: 'project-1',
      sessionId: 'session-1'
    }

    await expect(repository.enqueue(source)).resolves.toBeUndefined()
    await expect(repository.find('compute-job:job-missing')).resolves.toBeUndefined()
  })

  it('allows only one concurrent claimer to own a pending Session batch', async () => {
    await repository.enqueue(localRun('run-claim'))

    const [left, right] = await Promise.all([
      repository.claimPending('session-1', {
        token: 'claim-left',
        expiresAt: 2_000,
        limit: 8,
        now: 1_000
      }),
      repository.claimPending('session-1', {
        token: 'claim-right',
        expiresAt: 2_000,
        limit: 8,
        now: 1_000
      })
    ])

    expect([left.length, right.length].sort()).toEqual([0, 1])
    const winner = [...left, ...right][0]
    expect(winner).toMatchObject({ state: 'claimed' })
  })

  it('recovers an expired dispatch lease without losing its continuation identity', async () => {
    const pending = await repository.enqueue(localRun('run-recover'))
    const [claimed] = await repository.claimPending('session-1', {
      token: 'claim-1',
      expiresAt: 2_000,
      limit: 1,
      now: 1_000
    })
    await repository.prepareContinuation([claimed.id], 'claim-1', 'continuation-1')
    await repository.beginDispatch([claimed.id], 'claim-1', 'continuation-1')

    await expect(repository.recoverExpiredClaims(2_001)).resolves.toBe(1)
    await expect(repository.find(pending!.id)).resolves.toMatchObject({
      state: 'pending',
      continuationMessageId: 'continuation-1'
    })
  })

  it('claims every member of a recovered continuation even when a newer item is interleaved', async () => {
    await repository.enqueue(localRun('run-batch-1'))
    const interleaved = localRun('run-interleaved')
    await repository.register(interleaved)
    for (let index = 2; index <= 16; index += 1) {
      await repository.enqueue(localRun(`run-batch-${index}`))
    }
    const original = await repository.claimPending('session-1', {
      token: 'claim-original',
      expiresAt: 2_000,
      limit: 16,
      now: 1_000
    })
    await repository.prepareContinuation(
      original.map(({ id }) => id),
      'claim-original',
      'continuation-16'
    )
    await repository.beginDispatch(
      original.map(({ id }) => id),
      'claim-original',
      'continuation-16'
    )
    await repository.recoverExpiredClaims(2_001)
    await repository.enqueue(interleaved)

    const recovered = await repository.claimPending('session-1', {
      token: 'claim-recovered',
      expiresAt: 4_000,
      limit: 16,
      now: 2_001
    })

    expect(recovered).toHaveLength(16)
    expect(
      recovered.every(({ continuationMessageId }) => continuationMessageId === 'continuation-16')
    ).toBe(true)
  })

  it('keeps recovered timestamps comparable with ordinary Prisma writes', async () => {
    const recovered = await repository.enqueue(localRun('run-expired'))
    await repository.claimPending('session-1', {
      token: 'claim-expired',
      expiresAt: 2_000,
      limit: 1,
      now: 1_000
    })
    await repository.recoverExpiredClaims(3_000)
    const newer = await repository.enqueue(localRun('run-newer'))

    await expect(repository.listProjectVisible('project-1')).resolves.toEqual([
      expect.objectContaining({ id: newer!.id }),
      expect.objectContaining({ id: recovered!.id })
    ])
  })

  it('settles a saved continuation as one batch and keeps it out of Project activity', async () => {
    const first = await repository.enqueue(localRun('run-batch-1'))
    const second = await repository.enqueue(localRun('run-batch-2'))
    const claimed = await repository.claimPending('session-1', {
      token: 'claim-1',
      expiresAt: 5_000,
      limit: 8,
      now: 1_000
    })
    await repository.prepareContinuation(
      claimed.map(({ id }) => id),
      'claim-1',
      'continuation-1'
    )

    await expect(repository.listContinuation('session-1', 'continuation-1')).resolves.toHaveLength(
      2
    )
    await expect(repository.consumeContinuation('session-1', 'continuation-1')).resolves.toBe(2)
    await expect(repository.listProjectVisible('project-1')).resolves.toEqual([])
    await expect(repository.areConsumed([first!.id, second!.id], 'session-1')).resolves.toBe(true)
  })

  it('reports whether direct observation won the delivery transition', async () => {
    const source = localRun('run-observed')
    await repository.enqueue(source)

    await expect(repository.acknowledgeObserved(source)).resolves.toMatchObject({
      transitioned: true,
      delivery: { state: 'consumed' }
    })
    await expect(repository.acknowledgeObserved(source)).resolves.toMatchObject({
      transitioned: false,
      delivery: { state: 'consumed' }
    })
  })
})
