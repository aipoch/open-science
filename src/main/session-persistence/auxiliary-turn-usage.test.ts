import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionProjectionRepository } from './projection'
import {
  SessionAuxiliaryTurnUsageRecorder,
  type SessionAuxiliaryTurnUsageRecord
} from './auxiliary-turn-usage'

let root: string
let client: PrismaClient
let projection: SessionProjectionRepository
let recorder: SessionAuxiliaryTurnUsageRecorder
const record = (eventId: string): SessionAuxiliaryTurnUsageRecord => ({
  projectId: 'project',
  sessionId: 'session',
  eventId,
  source: 'side-chat',
  frameworkId: 'opencode',
  model: 'model',
  completedAtMs: 100,
  usage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3 }
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-science-auxiliary-retry-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project', name: 'Project' } })
  projection = new SessionProjectionRepository(async () => client)
  const session = await projection.prepareSave({
    id: 'session',
    projectId: 'project',
    title: 'Session',
    cwd: '/workspace',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: []
  })
  await projection.commitSave(session)
  recorder = new SessionAuxiliaryTurnUsageRecorder(async () => client)
})

afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('auxiliary usage recovery through SQLite', () => {
  it('retries an earlier failed measurement when the next auxiliary call is recorded', async () => {
    // This connection owns both transactions: SQLite itself rejects the write, without mocking
    // the recorder or its callers. Reads still work, as with a temporarily read-only database.
    await client.$executeRawUnsafe('PRAGMA query_only = ON')
    await expect(recorder.record(record('first'))).rejects.toThrow(/readonly/i)
    expect(await client.sessionAuxiliaryTurnUsage.count()).toBe(0)
    await client.$executeRawUnsafe('PRAGMA query_only = OFF')
    expect((await projection.usage()).usageEvents).toHaveLength(0)

    await recorder.record(record('second'))
    const rows = await client.sessionAuxiliaryTurnUsage.findMany({ orderBy: { eventId: 'asc' } })
    expect(rows.map((row) => row.eventId)).toEqual(['first', 'second'])
    expect(
      (await projection.usage()).usageEvents.reduce(
        (total, event) => total + event.inputTokens + event.cacheTokens + event.outputTokens,
        0
      )
    ).toBe(30)
  })

  it('keeps refresh failures observable and recovers the original measurement exactly once', async () => {
    const input = record('first')
    await client.$executeRawUnsafe('PRAGMA query_only = ON')
    await expect(recorder.record(input)).rejects.toThrow(/readonly/i)
    await expect(recorder.flush()).rejects.toThrow(/readonly/i)
    expect(await client.sessionAuxiliaryTurnUsage.count()).toBe(0)

    input.usage.inputTokens = 999
    await client.$executeRawUnsafe('PRAGMA query_only = OFF')
    await Promise.all([recorder.flush(), recorder.flush()])
    await expect(recorder.record(input)).resolves.toBe(false)
    await recorder.flush()

    const rows = await client.sessionAuxiliaryTurnUsage.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ eventId: 'first', inputTokens: 10n, outputTokens: 3n })
  })

  it('discards pending measurements when their session has been deleted', async () => {
    await client.$executeRawUnsafe('PRAGMA query_only = ON')
    await expect(recorder.record(record('first'))).rejects.toThrow(/readonly/i)
    await client.$executeRawUnsafe('PRAGMA query_only = OFF')
    await client.session.update({ where: { id: 'session' }, data: { deletedAtMs: 200n } })

    await expect(recorder.flush()).resolves.toBeUndefined()
    await expect(recorder.flush()).resolves.toBeUndefined()
    expect(await client.sessionAuxiliaryTurnUsage.count()).toBe(0)
    expect((await projection.usage()).usageEvents).toHaveLength(0)
  })

  it('rejects malformed measurements without blocking future statistics refreshes', async () => {
    const input = record('invalid')
    input.usage.inputTokens = -1
    await expect(recorder.record(input)).rejects.toThrow(/inputTokens/)
    await expect(recorder.flush()).resolves.toBeUndefined()
    await expect(recorder.record(record('valid'))).resolves.toBe(true)
    expect(await client.sessionAuxiliaryTurnUsage.count()).toBe(1)
  })
})
