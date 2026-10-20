import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { ClassificationUsageRecorder } from './classification-usage'
import type { ClassificationRequestUsage } from '../../shared/classification'

let root: string
let db: ReturnType<typeof createProjectDbClient>
let recorder: ClassificationUsageRecorder
const started: ClassificationRequestUsage = {
  eventId: 'request-1',
  providerId: 'classification:fixture',
  model: 'fixture',
  occurredAt: 1_700_000_000_000,
  status: 'started'
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'literature-usage-'))
  db = createProjectDbClient(root)
  await migrateApplicationDatabase(db)
  recorder = new ClassificationUsageRecorder(async () => db)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await db.$disconnect()
  await rm(root, { recursive: true, force: true })
})

it('deduplicates measurements, excludes Run rollups, and retains consumption after collection deletion', async () => {
  await db.literatureCollection.create({
    data: {
      id: 'collection',
      name: 'Trials',
      nameKey: 'trials',
      smart: { create: { scopeKind: 'library' } }
    }
  })
  await db.literatureSmartRuleRevision.create({
    data: {
      collectionId: 'collection',
      revision: 1,
      description: '',
      inclusionCriteria: 'Original studies',
      exclusionCriteria: '',
      scopeKind: 'library',
      evidenceMode: 'abstract'
    }
  })
  await db.literatureSmartRun.create({
    data: {
      id: 'run',
      collectionId: 'collection',
      kind: 'refresh',
      state: 'completed',
      ruleRevision: 1,
      policyKey: 'fixture'
    }
  })
  const observe = recorder.observer({
    collectionId: 'collection',
    runId: 'run',
    scenario: 'literature-update'
  })
  await observe(started)
  await observe({ ...started, status: 'completed', inputTokens: 40, outputTokens: 2 })
  await observe({ ...started, status: 'completed', inputTokens: 40, outputTokens: 2 })
  await observe(started)
  expect(await db.classificationUsage.count()).toBe(1)
  const projection = new SessionProjectionRepository(async () => db)
  expect(await projection.usage()).toMatchObject({
    sessionCreatedAt: [],
    runsAt: [],
    usageEvents: [
      {
        source: 'literature-classification',
        inputTokens: 40,
        outputTokens: 2,
        usageIncomplete: false
      }
    ]
  })
  await db.literatureCollection.delete({ where: { id: 'collection' } })
  expect(await db.literatureSmartRun.count()).toBe(0)
  expect((await projection.usage()).usageEvents).toHaveLength(1)
})

it('retains unsaved preview consumption and marks abandoned requests incomplete after restart', async () => {
  const observe = recorder.observer({ scenario: 'literature-live-preview' })
  await observe(started)
  await observe({ ...started, eventId: 'known', status: 'started' })
  await observe({ ...started, eventId: 'known', status: 'failed', inputTokens: 7, outputTokens: 1 })
  const restarted = new ClassificationUsageRecorder(async () => db)
  await restarted.flush()
  expect(
    await db.classificationUsage.findUnique({ where: { eventId: started.eventId } })
  ).toMatchObject({
    status: 'interrupted',
    collectionId: null,
    runId: null,
    inputTokens: null,
    outputTokens: null,
    usageIncomplete: true
  })
  expect(await db.classificationUsage.findUnique({ where: { eventId: 'known' } })).toMatchObject({
    status: 'failed',
    inputTokens: 7n,
    outputTokens: 1n,
    usageIncomplete: false
  })
})

it('recovers a failed final write without another model request or double counting', async () => {
  const observe = recorder.observer({ scenario: 'literature-trial' })
  await observe(started)
  const write = vi
    .spyOn(db.classificationUsage, 'updateMany')
    .mockRejectedValueOnce(new Error('temporary write failure'))
  await observe({ ...started, status: 'completed', inputTokens: 8, outputTokens: 3 })
  expect(await db.classificationUsage.findFirst()).toMatchObject({
    usageIncomplete: true
  })
  await recorder.flush()
  await recorder.flush()
  expect(await db.classificationUsage.findFirst()).toMatchObject({
    inputTokens: 8n,
    outputTokens: 3n,
    usageIncomplete: false
  })
  expect(write).toHaveBeenCalledTimes(2)
})

it('rejects invalid token measurements and enforces schema constraints', async () => {
  const observe = recorder.observer({ scenario: 'literature-update' })
  await observe(started)
  await expect(
    observe({ ...started, status: 'completed', inputTokens: -1, outputTokens: 2 })
  ).rejects.toThrow()
  await expect(observe({ ...started, status: 'completed', inputTokens: 1 })).rejects.toThrow()
  await expect(
    db.$executeRawUnsafe(
      'UPDATE ClassificationUsage SET inputTokens = -1, outputTokens = 0, usageIncomplete = false'
    )
  ).rejects.toThrow()
  await expect(
    db.$executeRawUnsafe("UPDATE ClassificationUsage SET status = 'unknown'")
  ).rejects.toThrow()
})

async function automaticRun(): Promise<void> {
  await db.literatureCollection.create({
    data: {
      id: 'automatic',
      name: 'Automatic',
      nameKey: 'automatic',
      smart: {
        create: { scopeKind: 'library', autoUpdate: true, automaticPauseReason: 'interrupted' }
      }
    }
  })
  await db.literatureSmartRuleRevision.create({
    data: {
      collectionId: 'automatic',
      revision: 1,
      description: '',
      inclusionCriteria: 'Trials',
      exclusionCriteria: '',
      scopeKind: 'library',
      evidenceMode: 'abstract'
    }
  })
  await db.literatureSmartRun.create({
    data: {
      id: 'automatic-run',
      collectionId: 'automatic',
      ruleRevision: 1,
      kind: 'refresh',
      state: 'running',
      policyKey: 'fixture'
    }
  })
}
it('atomically limits concurrent automatic attempts and counts retries as requests', async () => {
  await automaticRun()
  await db.classificationUsage.createMany({
    data: Array.from({ length: 199 }, (_, i) => ({
      eventId: `prior-${i}`,
      scenario: 'literature-automatic',
      runId: 'automatic-run',
      providerId: 'fixture',
      model: 'fixture',
      occurredAt: new Date(),
      status: 'completed'
    }))
  })
  const observe = recorder.observer({
    scenario: 'literature-automatic',
    collectionId: 'automatic',
    runId: 'automatic-run'
  })
  const results = await Promise.allSettled([
    observe({ ...started, eventId: 'last' }),
    observe({ ...started, eventId: 'retry' })
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(await db.classificationUsage.count()).toBe(200)
  expect(
    await db.literatureSmartCollection.findUniqueOrThrow({ where: { collectionId: 'automatic' } })
  ).toMatchObject({ automaticPauseReason: 'run-limit', automaticPauseRunId: 'automatic-run' })
  await expect(observe({ ...started, eventId: 'blocked' })).rejects.toMatchObject({
    reason: 'run-limit'
  })
})
it('enforces the rolling shared daily budget across runs and keeps the pause after restart', async () => {
  await automaticRun()
  await db.classificationUsage.createMany({
    data: Array.from({ length: 1000 }, (_, i) => ({
      eventId: `other-${i}`,
      scenario: 'literature-automatic',
      runId: 'other-run',
      providerId: 'other-provider',
      model: 'fixture',
      occurredAt: new Date(),
      status: 'completed'
    }))
  })
  const context = {
    scenario: 'literature-automatic' as const,
    collectionId: 'automatic',
    runId: 'automatic-run'
  }
  await expect(
    recorder.observer(context)({ ...started, eventId: 'blocked' })
  ).rejects.toMatchObject({ reason: 'daily-limit' })
  recorder = new ClassificationUsageRecorder(async () => db)
  await expect(
    recorder.observer(context)({ ...started, eventId: 'restart' })
  ).rejects.toMatchObject({ reason: 'daily-limit' })
  await db.classificationUsage.updateMany({ data: { occurredAt: new Date(Date.now() - 86400001) } })
  // A new window alone does not unpause the collection; explicit resume re-arms it.
  await expect(
    recorder.observer(context)({ ...started, eventId: 'still-paused' })
  ).rejects.toMatchObject({ reason: 'daily-limit' })
  await db.literatureSmartCollection.update({
    where: { collectionId: 'automatic' },
    data: { automaticPauseReason: 'interrupted' }
  })
  await recorder.observer(context)({ ...started, eventId: 'resumed' })
  expect(await db.classificationUsage.count()).toBe(1001)
})
