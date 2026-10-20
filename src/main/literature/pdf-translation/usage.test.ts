import { toTranslationSourceId } from '../../../shared/pdf-translation'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createProjectDbClient } from '../../projects/prisma-client'
import { migrateApplicationDatabase } from '../../database/migration-service'
import { SessionProjectionRepository } from '../../session-persistence/projection'
import { PdfTranslationUsageRecorder } from './usage'
import {
  beginMigration,
  endMigration,
  initializeDataRootWriteAvailability,
  reconcileDataRootWriteAvailability
} from '../../storage/migration-state'
import { PdfTranslationOwner } from './index'

let root: string
let db: ReturnType<typeof createProjectDbClient>
let recorder: PdfTranslationUsageRecorder
const context = {
  runId: 'translation',
  sourceId: toTranslationSourceId('version'),
  sourceIndex: 2,
  providerId: 'provider',
  frameworkId: 'direct-api',
  model: 'model'
}
const usage = {
  inputTokens: 40,
  cacheTokens: 12,
  cachedReadTokens: 10,
  cachedWriteTokens: 2,
  outputTokens: 8
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-usage-'))
  db = createProjectDbClient(root)
  await migrateApplicationDatabase(db)
  recorder = new PdfTranslationUsageRecorder(async () => db)
})
afterEach(async () => {
  endMigration()
  initializeDataRootWriteAvailability(false)
  vi.restoreAllMocks()
  await db?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

it('records each attempt once and projects consumption independently of document/session lifetime', async () => {
  const finish = await recorder.start(context)
  expect(await db.pdfTranslationUsage.findFirst()).toMatchObject({
    status: 'started',
    inputTokens: null,
    usageIncomplete: true
  })
  await finish({ status: 'failed', usage })
  await finish({ status: 'completed', usage })
  const retry = await recorder.start(context)
  await retry({ status: 'completed', usage: { inputTokens: 4, cacheTokens: 0, outputTokens: 1 } })
  const missing = await recorder.start({ ...context, sourceIndex: 3 })
  await missing({ status: 'interrupted' })
  const rows = await db.pdfTranslationUsage.findMany()
  expect(rows).toHaveLength(3)
  expect(rows.find((row) => row.status === 'failed')).toMatchObject({
    inputTokens: 40n,
    cacheTokens: 12n,
    outputTokens: 8n,
    usageIncomplete: false
  })
  expect(rows.find((row) => row.status === 'interrupted')).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    usageIncomplete: true
  })
  const projected = await new SessionProjectionRepository(async () => db).usage()
  expect(projected.usageEvents).toHaveLength(3)
  expect(projected.usageEvents.every((event) => event.source === 'literature-translation')).toBe(
    true
  )
  expect(
    projected.usageEvents.reduce(
      (sum, event) => sum + event.inputTokens + event.cacheTokens + event.outputTokens,
      0
    )
  ).toBe(65)
  expect(projected.usageEvents.filter((event) => event.usageIncomplete)).toHaveLength(1)
  expect(projected.sessionCreatedAt).toEqual([])
})

it('pins terminal writes to the database used when the request started', async () => {
  let current = db
  const pinned = new PdfTranslationUsageRecorder(async () => current)
  const finish = await pinned.start(context)
  const otherRoot = await mkdtemp(join(tmpdir(), 'pdf-usage-other-'))
  const other = createProjectDbClient(otherRoot)
  try {
    await migrateApplicationDatabase(other)
    current = other
    await finish({ status: 'completed', usage })
    expect(await db.pdfTranslationUsage.findFirst()).toMatchObject({
      status: 'completed',
      outputTokens: 8n
    })
    expect(await other.pdfTranslationUsage.count()).toBe(0)
  } finally {
    await other.$disconnect()
    await rm(otherRoot, { recursive: true, force: true })
  }
})

it('blocks new usage writes during migration and retains terminal updates for a later flush', async () => {
  const finish = await recorder.start(context)
  beginMigration()
  await expect(recorder.start(context)).rejects.toThrow(/moving your data/i)
  await expect(new PdfTranslationUsageRecorder(async () => db).recover()).rejects.toThrow(
    /moving your data/i
  )
  await finish({ status: 'completed', usage })
  await expect(recorder.flush()).rejects.toThrow(/moving your data/i)
  expect(await db.pdfTranslationUsage.findFirst()).toMatchObject({ status: 'started' })
  expect(await db.pdfTranslationUsage.count()).toBe(1)
  endMigration()
  await recorder.flush()
  expect(await db.pdfTranslationUsage.findFirst()).toMatchObject({
    status: 'completed',
    inputTokens: 40n,
    outputTokens: 8n
  })
})

it('defers missing-root startup recovery and retries a failed reconnect before admitting writes', async () => {
  await recorder.start(context)
  const getClient = vi.fn(async () => db)
  const restarted = new PdfTranslationUsageRecorder(getClient)
  const sweepStaleProfiles = vi.fn(async () => {})
  const owner = new PdfTranslationOwner({
    usage: restarted,
    captureTarget: vi.fn(),
    runner: {
      run: vi.fn(),
      supportsTarget: vi.fn(),
      shutdown: async () => {},
      sweepStaleProfiles
    }
  })
  initializeDataRootWriteAvailability(true)
  try {
    await owner.sweepStaleProfiles()
    expect(sweepStaleProfiles).toHaveBeenCalledOnce()
    expect(getClient).not.toHaveBeenCalled()
    expect(await db.pdfTranslationUsage.findFirst()).toMatchObject({ status: 'started' })

    let admitted = false
    const pending = restarted.start(context).then((finish) => {
      admitted = true
      return finish({ status: 'completed', usage })
    })
    const write = vi
      .spyOn(db.pdfTranslationUsage, 'updateMany')
      .mockRejectedValueOnce(new Error('reconnect unavailable'))
    await expect(reconcileDataRootWriteAvailability(false)).rejects.toThrow('reconnect unavailable')
    expect(admitted).toBe(false)
    expect(await db.pdfTranslationUsage.count()).toBe(1)
    write.mockRestore()

    await reconcileDataRootWriteAvailability(false)
    await pending
    expect(admitted).toBe(true)
    expect((await db.pdfTranslationUsage.findMany()).map((row) => row.status).sort()).toEqual([
      'completed',
      'interrupted'
    ])
    await restarted.flush()
  } finally {
    initializeDataRootWriteAvailability(false)
    await owner.shutdown()
  }
})
