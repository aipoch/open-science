import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'
import { SessionAuxiliaryTurnUsageRecorder } from './auxiliary-turn-usage'
import { SessionProjectionRepository } from './projection'

type ProjectionWrite = { tableName: string; operation: string; identity: string }

const messagesForTurn = (index: number): PersistedChatMessage[] => [
  {
    id: `prompt-${index}`,
    role: 'user',
    content: `Prompt ${index}`,
    status: 'complete',
    eventIds: [],
    createdAt: index * 10 + 1,
    updatedAt: index * 10 + 1
  },
  {
    id: `reply-${index}`,
    role: 'agent',
    content: `Reply ${index}`,
    status: 'complete',
    eventIds: [],
    createdAt: index * 10 + 2,
    updatedAt: index * 10 + 3,
    completedAt: index * 10 + 3,
    turnUsage: { inputTokens: 10, cacheTokens: 0, outputTokens: 3, turnCount: 2 },
    modelCallUsage: [
      { id: `call-${index}-0`, index: 0, inputTokens: 6, cacheTokens: 0, outputTokens: 1 },
      { id: `call-${index}-1`, index: 1, inputTokens: 4, cacheTokens: 0, outputTokens: 2 }
    ]
  }
]

const createSession = (): PersistedChatSession => ({
  id: 'incremental-session',
  projectId: 'project-1',
  title: 'Incremental session',
  cwd: '/workspace',
  status: 'idle',
  revision: 1,
  messages: [...messagesForTurn(1), ...messagesForTurn(2)],
  artifacts: [{ id: 'artifact-1', kind: 'managed-file', path: 'result.md', createdAt: 30 }],
  createdAt: 1,
  updatedAt: 30
})

// SQLite triggers observe actual row writes, including cascading deletes. A mock counting ORM calls
// would miss writes caused by upsert or foreign keys and could incorrectly certify the optimization.
const installWriteProbe = async (client: PrismaClient): Promise<void> => {
  await client.$executeRawUnsafe(
    'CREATE TABLE ProjectionWriteProbe (tableName TEXT NOT NULL, operation TEXT NOT NULL, identity TEXT NOT NULL)'
  )
  const tables = [
    ['Session', 'id'],
    ['SessionTurnUsage', 'messageId'],
    ['SessionModelCallUsage', 'callId'],
    ['SessionRun', 'messageId'],
    ['SessionArtifactRef', 'artifactId'],
    ['SessionAuxiliaryTurnUsage', 'eventId']
  ] as const
  for (const [table, identity] of tables) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW'
      await client.$executeRawUnsafe(
        `CREATE TRIGGER "probe_${table}_${operation}" AFTER ${operation} ON "${table}"
         BEGIN INSERT INTO ProjectionWriteProbe VALUES ('${table}', '${operation}', ${row}."${identity}"); END`
      )
    }
  }
}

describe('incremental Session SQLite projection', () => {
  let client: PrismaClient
  let storageRoot: string
  let projection: SessionProjectionRepository

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-incremental-projection-'))
    initDataRoot(storageRoot)
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    projection = new SessionProjectionRepository(async () => client)
    await installWriteProbe(client)
  })

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  const clearWrites = async (): Promise<void> => {
    await client.$executeRawUnsafe('DELETE FROM ProjectionWriteProbe')
  }
  const writes = async (): Promise<ProjectionWrite[]> =>
    client.$queryRawUnsafe<ProjectionWrite[]>(
      'SELECT tableName, operation, identity FROM ProjectionWriteProbe ORDER BY tableName, operation, identity'
    )
  const childWrites = async (): Promise<ProjectionWrite[]> =>
    (await writes()).filter(({ tableName }) => tableName !== 'Session')
  const seed = async (input = createSession()): Promise<PersistedChatSession> => {
    const { session } = await projection.prepareSave(input)
    await projection.commitSave(session)
    await clearWrites()
    return session
  }

  const observeProjectionReads = (session: PersistedChatSession): ReturnType<typeof vi.fn> => {
    const usage = session.messages[1].turnUsage
    const readUsage = vi.fn(() => usage)
    Object.defineProperty(session.messages[1], 'turnUsage', {
      enumerable: true,
      configurable: true,
      get: readUsage
    })
    return readUsage
  }

  it('reuses a prepared projection once while committing the allocated number and new revision', async () => {
    const input = createSession()
    const reads = observeProjectionReads(input)
    const prepared = await projection.prepareSave(input)
    const afterPreparation = reads.mock.calls.length
    expect(afterPreparation).toBeGreaterThan(0)
    expect(input.number).toBeUndefined()
    const durable = { ...prepared.session, revision: 2 }
    await projection.commitSave(durable, prepared)
    expect(reads).toHaveBeenCalledTimes(afterPreparation)
    await expect(client.session.findUnique({ where: { id: input.id } })).resolves.toMatchObject({
      number: prepared.session.number,
      revision: 2n
    })

    await projection.commitSave(durable, prepared)
    expect(reads.mock.calls.length).toBeGreaterThan(afterPreparation)
  })

  it('does not accept a prepared projection token from another repository instance', async () => {
    const input = createSession()
    const reads = observeProjectionReads(input)
    const prepared = await projection.prepareSave(input)
    const afterPreparation = reads.mock.calls.length
    const other = new SessionProjectionRepository(async () => client)
    await other.commitSave(prepared.session, prepared)
    expect(reads.mock.calls.length).toBeGreaterThan(afterPreparation)
    await expect(client.sessionTurnUsage.count()).resolves.toBe(2)
  })

  it.each(['title', 'number', 'messages'] as const)(
    'rebuilds a prepared projection when its returned session changes %s',
    async (field) => {
      const input = createSession()
      const reads = observeProjectionReads(input)
      const prepared = await projection.prepareSave(input)
      const afterPreparation = reads.mock.calls.length
      // Changing the returned object itself must not change the stored receipt's field snapshot.
      if (field === 'title') prepared.session.title = 'Changed after preparation'
      if (field === 'number') prepared.session.number! += 10
      if (field === 'messages') prepared.session.messages = [...prepared.session.messages]
      await projection.commitSave(prepared.session, prepared)
      expect(reads.mock.calls.length).toBeGreaterThan(afterPreparation)
      await expect(client.session.findUnique({ where: { id: input.id } })).resolves.toMatchObject({
        title: prepared.session.title,
        number: prepared.session.number
      })
    }
  )

  it('still rejects malformed projection data when a prepared candidate changes', async () => {
    const prepared = await projection.prepareSave(createSession())
    const candidate = {
      ...prepared.session,
      messages: [...prepared.session.messages, prepared.session.messages[0]]
    }
    await expect(projection.commitSave(candidate, prepared)).rejects.toThrow(
      'Session projection run.messageId must be unique.'
    )
    await expect(client.sessionTurnUsage.count()).resolves.toBe(0)
    await expect(projection.pending()).resolves.toHaveLength(1)
  })

  it('writes no unchanged rows and updates only the summary for a metadata edit', async () => {
    const session = await seed()
    await projection.commitSave(session)
    expect(await writes()).toEqual([])

    await projection.commitSave({ ...session, title: 'Renamed', revision: 2, updatedAt: 31 })
    expect(await writes()).toEqual([
      { tableName: 'Session', operation: 'UPDATE', identity: session.id }
    ])
    await expect(client.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      title: 'Renamed',
      revision: 2n
    })
  })

  it('updates only the affected turn and model call when token usage arrives late', async () => {
    const session = await seed()
    const next = structuredClone(session)
    next.messages[3].turnUsage!.outputTokens += 5
    next.messages[3].modelCallUsage![1].outputTokens += 5
    await projection.commitSave(next)

    expect(await childWrites()).toEqual([
      { tableName: 'SessionModelCallUsage', operation: 'UPDATE', identity: 'call-2-1' },
      { tableName: 'SessionTurnUsage', operation: 'UPDATE', identity: 'reply-2' }
    ])
    await expect(
      client.sessionTurnUsage.findUnique({
        where: { sessionId_messageId: { sessionId: session.id, messageId: 'reply-2' } }
      })
    ).resolves.toMatchObject({ outputTokens: 8n })
    await expect(projection.usage()).resolves.toMatchObject({
      usageEvents: expect.arrayContaining([expect.objectContaining({ outputTokens: 8 })])
    })
  })

  it('inserts new facts and deletes only removed turn, run, call and artifact identities', async () => {
    const session = await seed()
    const next = {
      ...session,
      messages: [...session.messages.slice(2), ...messagesForTurn(3)],
      artifacts: [
        { id: 'artifact-2', kind: 'managed-file' as const, path: 'new.md', createdAt: 40 }
      ]
    }
    await projection.commitSave(next)
    const changes = await childWrites()
    expect(changes).toHaveLength(10)
    expect(changes).toEqual(
      expect.arrayContaining([
        { tableName: 'SessionTurnUsage', operation: 'DELETE', identity: 'reply-1' },
        { tableName: 'SessionTurnUsage', operation: 'INSERT', identity: 'reply-3' },
        { tableName: 'SessionRun', operation: 'DELETE', identity: 'prompt-1' },
        { tableName: 'SessionRun', operation: 'INSERT', identity: 'prompt-3' },
        { tableName: 'SessionModelCallUsage', operation: 'DELETE', identity: 'call-1-0' },
        { tableName: 'SessionModelCallUsage', operation: 'DELETE', identity: 'call-1-1' },
        { tableName: 'SessionModelCallUsage', operation: 'INSERT', identity: 'call-3-0' },
        { tableName: 'SessionModelCallUsage', operation: 'INSERT', identity: 'call-3-1' },
        { tableName: 'SessionArtifactRef', operation: 'DELETE', identity: 'artifact-1' },
        { tableName: 'SessionArtifactRef', operation: 'INSERT', identity: 'artifact-2' }
      ])
    )
    await expect(client.sessionModelCallUsage.count()).resolves.toBe(4)
    await expect(client.sessionTurnUsage.count()).resolves.toBe(2)
  })

  it('supports swapping unique call positions without rewriting unrelated calls', async () => {
    const session = await seed()
    const next = structuredClone(session)
    next.messages[1].modelCallUsage![0].index = 1
    next.messages[1].modelCallUsage![1].index = 0
    await projection.commitSave(next)

    expect(await childWrites()).toEqual([
      { tableName: 'SessionModelCallUsage', operation: 'DELETE', identity: 'call-1-0' },
      { tableName: 'SessionModelCallUsage', operation: 'DELETE', identity: 'call-1-1' },
      { tableName: 'SessionModelCallUsage', operation: 'INSERT', identity: 'call-1-0' },
      { tableName: 'SessionModelCallUsage', operation: 'INSERT', identity: 'call-1-1' }
    ])
    await expect(
      client.sessionModelCallUsage.findMany({
        where: { sessionId: session.id, messageId: 'reply-1' },
        orderBy: { callIndex: 'asc' }
      })
    ).resolves.toMatchObject([{ callId: 'call-1-1' }, { callId: 'call-1-0' }])
  })

  it('moves a call before removing its old turn without losing it through cascade deletion', async () => {
    const session = await seed()
    const next = structuredClone(session)
    const moved = next.messages[1].modelCallUsage![0]
    next.messages = next.messages.slice(2)
    next.messages[1].modelCallUsage!.push({ ...moved, index: 2 })
    next.messages[1].turnUsage = {
      inputTokens: 16,
      cacheTokens: 0,
      outputTokens: 4,
      turnCount: 3
    }
    await projection.commitSave(next)

    await expect(
      client.sessionModelCallUsage.findUnique({
        where: { sessionId_callId: { sessionId: session.id, callId: moved.id } }
      })
    ).resolves.toMatchObject({ messageId: 'reply-2', callIndex: 2 })
    expect((await childWrites()).filter(({ identity }) => identity.startsWith('call-2'))).toEqual(
      []
    )
    await expect(client.sessionModelCallUsage.count()).resolves.toBe(3)
  })

  it('preserves inactive branch consumption and performs no child writes when switching branches', async () => {
    const input = createSession()
    const originalGraph = createLinearConversationGraph({
      sessionId: input.id,
      messages: input.messages,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    })
    const originalBranchId = originalGraph.frames[0].activeBranchId
    const session = await seed({ ...input, conversationGraph: originalGraph })
    const branch = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(originalGraph, 'prompt-1', 'edited-branch', 40),
      messagesForTurn(3),
      41
    )
    const branched = {
      ...session,
      conversationGraph: branch,
      messages: resolveActiveConversationMessages(branch)
    }
    await projection.commitSave(branched)
    await expect(client.sessionTurnUsage.count()).resolves.toBe(3)
    expect((await childWrites()).every(({ operation }) => operation === 'INSERT')).toBe(true)

    await clearWrites()
    const switched = activateConversationBranch(branch, originalBranchId)
    await projection.commitSave({
      ...branched,
      conversationGraph: switched,
      messages: resolveActiveConversationMessages(switched)
    })
    expect(await childWrites()).toEqual([])
    await expect(client.sessionModelCallUsage.count()).resolves.toBe(6)
  })

  it('keeps auxiliary facts append-once across replacement or removal of the active generation', async () => {
    const session = await seed()
    const recorder = new SessionAuxiliaryTurnUsageRecorder(async () => client)
    await recorder.record({
      projectId: session.projectId,
      sessionId: session.id,
      eventId: 'side-chat-event',
      source: 'side-chat',
      frameworkId: 'codex',
      completedAtMs: 30,
      usage: { inputTokens: 3, cacheTokens: 0, outputTokens: 4 }
    })
    const details = {
      status: 'failed' as const,
      sourceMessageId: 'prompt-1',
      requestId: 'details-1',
      queuedAt: 30,
      startedAt: 31,
      completedAt: 32,
      frameworkId: 'codex' as const,
      model: 'gpt-5',
      reasoningEffort: 'low' as const,
      usage: { inputTokens: 7, cacheTokens: 0, outputTokens: 2 }
    }
    const next: PersistedChatSession = { ...session, sessionDetailsGeneration: details }
    await projection.commitSave(next)
    await clearWrites()
    await projection.commitSave({
      ...next,
      sessionDetailsGeneration: {
        ...details,
        usage: { inputTokens: 999, cacheTokens: 0, outputTokens: 999 }
      }
    })
    expect(await childWrites()).toEqual([])
    await projection.commitSave({
      ...next,
      sessionDetailsGeneration: { ...details, requestId: 'details-2', completedAt: 40 }
    })
    expect(await childWrites()).toEqual([
      { tableName: 'SessionAuxiliaryTurnUsage', operation: 'INSERT', identity: 'details-2' }
    ])
    await clearWrites()
    await projection.commitSave({ ...next, sessionDetailsGeneration: undefined })
    expect(await childWrites()).toEqual([])
    await expect(
      client.sessionAuxiliaryTurnUsage.findMany({ orderBy: { eventId: 'asc' } })
    ).resolves.toMatchObject([
      { eventId: 'details-1', inputTokens: 7n, outputTokens: 2n },
      { eventId: 'details-2', inputTokens: 7n, outputTokens: 2n },
      { eventId: 'side-chat-event', inputTokens: 3n, outputTokens: 4n }
    ])
  })

  it('rolls back all changed rows on failure and replays the pending projection idempotently', async () => {
    const session = await seed()
    const next = structuredClone(session)
    next.revision = 2
    next.title = 'Recovered title'
    next.messages[3].turnUsage!.outputTokens = 42
    next.messages[3].modelCallUsage![1].outputTokens = 41
    next.artifacts![0].createdAt = 99
    await projection.markPending(session.projectId, session.id)
    await client.$executeRawUnsafe(
      `CREATE TRIGGER fail_artifact_projection BEFORE UPDATE ON SessionArtifactRef
       BEGIN SELECT RAISE(ABORT, 'injected artifact projection failure'); END`
    )
    // Prisma's SQLite engine reports a trigger RAISE(ABORT) as P2003 rather than exposing the
    // trigger message. Check the failing write as well as the engine code before checking rollback.
    await expect(projection.commitSave(next)).rejects.toMatchObject({
      code: 'P2003',
      message: expect.stringContaining('tx.sessionArtifactRef.update')
    })
    expect(await writes()).toEqual([])
    await expect(client.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      title: session.title,
      revision: 1n
    })
    await expect(
      client.sessionTurnUsage.findMany({ orderBy: { messageId: 'asc' } })
    ).resolves.toMatchObject([
      { messageId: 'reply-1', outputTokens: 3n },
      { messageId: 'reply-2', outputTokens: 3n }
    ])
    await expect(projection.pending()).resolves.toEqual([
      { projectId: session.projectId, sessionId: session.id, operation: 'save' }
    ])

    await client.$executeRawUnsafe('DROP TRIGGER fail_artifact_projection')
    await projection.commitReconciliation(next)
    await expect(projection.pending()).resolves.toEqual([])
    expect(await childWrites()).toEqual([
      { tableName: 'SessionArtifactRef', operation: 'UPDATE', identity: 'artifact-1' },
      { tableName: 'SessionModelCallUsage', operation: 'UPDATE', identity: 'call-2-1' },
      { tableName: 'SessionTurnUsage', operation: 'UPDATE', identity: 'reply-2' }
    ])
    await clearWrites()
    await projection.commitReconciliation(next)
    expect(await writes()).toEqual([])
  })
})
