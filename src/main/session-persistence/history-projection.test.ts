import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import { createSessionFile, decodeSessionFile } from '../../shared/session-persistence'
import { decodeSessionDataPaths } from './session-data-paths'
import { SessionHistoryCursorStaleError } from '../../shared/session-history'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionHistoryProjectionRepository } from './history-projection'

let root: string | undefined
let client: PrismaClient | undefined
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
  client = undefined
})
const setup = async (): Promise<SessionHistoryProjectionRepository> => {
  root = await mkdtemp(join(tmpdir(), 'session-history-index-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  return new SessionHistoryProjectionRepository(async () => client!)
}
const message = (id: string, role: 'user' | 'agent', createdAt: number): PersistedChatMessage => ({
  id,
  role,
  content: `${id} body`,
  status: 'complete',
  ...(role === 'agent' ? { completedAt: createdAt } : {}),
  eventIds: [],
  createdAt,
  updatedAt: createdAt
})
const session = (tools = 100): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  revision: 1,
  title: 'History',
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: 200,
  messages: [
    message('prompt', 'user', 1),
    { ...message('answer', 'agent', 150), responseToMessageId: 'prompt', artifactIds: ['artifact'] }
  ],
  activities: Array.from({ length: tools }, (_, i) => ({
    id: `tool-${i}`,
    kind: 'tool',
    title: `Tool ${i}`,
    status: 'completed',
    sortIndex: i,
    eventIds: [],
    createdAt: i + 2,
    updatedAt: i + 3,
    promptMessageId: 'prompt',
    activityGroupId: 'group',
    rawOutput: { value: `full output ${i}` }
  })),
  activityGroups: [
    {
      id: 'group',
      title: 'Tools',
      sortIndex: 1,
      activityIds: Array.from({ length: tools }, (_, i) => `tool-${i}`),
      promptMessageId: 'prompt',
      createdAt: 2,
      updatedAt: 105,
      completedAt: 105
    }
  ],
  artifacts: [
    {
      id: 'artifact',
      kind: 'managed-file',
      path: '/artifact/result.txt',
      fileUrl: 'file:///artifact/result.txt'
    },
    {
      id: 'unrelated',
      kind: 'managed-file',
      path: '/artifact/old.txt',
      fileUrl: 'file:///artifact/old.txt'
    }
  ]
})
const request = { projectId: 'project-1', sessionId: 'session-1' }

describe('SQLite Session display history', () => {
  it('reads 80 complete business items, their prompt and clipped group without a full transcript', async () => {
    const index = await setup()
    const full = session()
    await index.sync(full, 'source-1')
    const first = (await index.readPage(request, 'source-1'))!
    expect(first.totalItems).toBe(102)
    expect(first.hasMore).toBe(true)
    expect(first.session.messages.map(({ id }) => id)).toEqual(['prompt', 'answer'])
    expect(first.session.activities).toEqual(full.activities!.slice(21))
    expect(first.session.activities).toHaveLength(79)
    expect(first.session.activityGroups).toEqual([
      { ...full.activityGroups![0], activityIds: full.activities!.slice(21).map(({ id }) => id) }
    ])
    expect(first.session.artifacts).toEqual([full.artifacts![0]])
    expect(first.session.conversationGraph).toBeUndefined()
    const second = (await index.readPage(
      { ...request, beforeCursor: first.beforeCursor },
      'source-1'
    ))!
    expect(second.hasMore).toBe(false)
    expect(second.beforeCursor).toBeUndefined()
    expect(second.session.activities).toEqual(full.activities!.slice(0, 21))
    const allTools = [...second.session.activities!, ...first.session.activities!]
    expect(allTools).toEqual(full.activities)
    const stored = await client!.sessionHistoryIndex.findUniqueOrThrow({
      where: { sessionId: full.id }
    })
    const header = JSON.parse(stored.headerJson)
    for (const field of [
      'messages',
      'activities',
      'activityGroups',
      'artifacts',
      'conversationGraph'
    ]) {
      expect(header).not.toHaveProperty(field)
    }
  })

  it('does not decode off-page tool bodies and preserves complete Unicode tool output', async () => {
    const index = await setup()
    const full = session()
    full.activities![99]!.rawOutput = { text: '科学🙂'.repeat(500) }
    await index.sync(full, 'source')
    await client!.sessionHistoryItem.update({
      where: {
        sessionId_kind_itemId: {
          sessionId: full.id,
          kind: 'activity',
          itemId: 'tool-0'
        }
      },
      data: { payloadJson: 'deliberately unreadable old body' }
    })
    const page = (await index.readPage(request, 'source'))!
    expect(page.session.activities!.at(-1)!.rawOutput).toEqual(full.activities![99]!.rawOutput)
    await expect(
      index.readPage({ ...request, beforeCursor: page.beforeCursor }, 'source')
    ).rejects.toThrow()
  })

  it('matches full decoder tool bounds, terminal event IDs and absolute artifact paths', async () => {
    const index = await setup()
    const full = session(2)
    full.activities![0]!.rawOutput = { text: 'oversized'.repeat(2_000) }
    full.activities![1]!.terminalOutput = 'output'.repeat(3_000)
    full.messages[1]!.eventIds = Array.from({ length: 10_000 }, (_, i) => `event-${i}`)
    const decoded = decodeSessionFile(createSessionFile(full), {
      preserveRuntimeState: true,
      preserveLegacyUploadPaths: true
    })
    expect(decoded.status).toBe('ok')
    if (decoded.status !== 'ok') throw new Error('Invalid test session')
    const expected = decodeSessionDataPaths(decoded.session, root!)
    full.conversationGraph = createSessionFile(full).session.conversationGraph
    await index.sync(full, 'source')
    const page = (await index.readPage(request, 'source'))!
    expect(page.session.messages).toEqual(expected.messages)
    expect(page.session.activities).toEqual(expected.activities)
    expect(page.session.activities![0]!.rawOutput).toBeUndefined()
    expect(page.session.activityGroups).toEqual(expected.activityGroups)
    expect(page.session.artifacts).toEqual([expected.artifacts![0]])
  })

  it('supports empty and small histories and enforces the bounded page request', async () => {
    const index = await setup()
    await index.sync({ ...session(0), messages: [] }, 'empty')
    expect(await index.readPage(request, 'empty')).toMatchObject({
      totalItems: 0,
      hasMore: false,
      session: { messages: [], activities: [], activityGroups: [], artifacts: [] }
    })
    await index.sync(session(1), 'small')
    const page = (await index.readPage({ ...request, limit: 1 }, 'small'))!
    expect(page.totalItems).toBe(3)
    expect(page.session.messages.map(({ id }) => id)).toEqual(['prompt', 'answer'])
    expect(page.session.activities).toEqual([])
    await expect(index.readPage({ ...request, limit: 201 }, 'small')).rejects.toThrow()
    await expect(index.readPage({ ...request, limit: 0 }, 'small')).rejects.toThrow()
  })

  it('invalidates a cursor after a new revision and isolates projects and source identities', async () => {
    const index = await setup()
    expect(await index.readPage(request, 'missing')).toBeUndefined()
    await index.sync(session(), 'source-1')
    const first = (await index.readPage(request, 'source-1'))!
    expect(await index.readPage(request, 'external-change')).toBeUndefined()
    expect(await index.readPage({ ...request, projectId: 'other' }, 'source-1')).toBeUndefined()
    await expect(
      index.readPage({ ...request, beforeCursor: 'not-json' }, 'source-1')
    ).rejects.toBeInstanceOf(SessionHistoryCursorStaleError)
    await index.sync({ ...session(), revision: 2 }, 'source-2')
    await expect(
      index.readPage({ ...request, beforeCursor: first.beforeCursor }, 'source-2')
    ).rejects.toBeInstanceOf(SessionHistoryCursorStaleError)
  })

  it('removes unused branch indexes and rebuilds pages when the graph becomes linear again', async () => {
    const index = await setup()
    const original = [message('u1', 'user', 1), message('a1', 'agent', 2)]
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: original,
      createdAt: 1,
      updatedAt: 2
    })
    const edited = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(graph, 'u1', 'edited-branch', 3),
      [message('u2', 'user', 3), message('a2', 'agent', 4)],
      4
    )
    const linear = {
      ...session(0),
      messages: original,
      conversationGraph: graph,
      activityGroups: []
    }
    await index.sync(linear, 'linear')
    const first = (await index.readPage({ ...request, limit: 1 }, 'linear'))!
    expect(first.hasMore).toBe(true)
    expect(await client!.sessionHistoryItem.count()).toBeGreaterThan(0)

    const full = { ...linear, revision: 2, conversationGraph: edited }
    await index.sync(full, 'edited')
    expect(await index.readPage(request, 'edited')).toBeUndefined()
    expect(await index.readPage(request, 'linear')).toBeUndefined()
    expect(await client!.sessionHistoryIndex.count()).toBe(0)
    expect(await client!.sessionHistoryItem.count()).toBe(0)
    await index.sync(
      {
        ...full,
        revision: 3,
        conversationGraph: activateConversationBranch(edited, graph.branches[0]!.id)
      },
      'original',
      {
        changes: { messages: [], activities: [], activityGroups: [], branches: [] },
        sourceFingerprint: 'edited'
      }
    )
    expect(await index.readPage(request, 'original')).toBeUndefined()
    expect(await client!.sessionHistoryIndex.count()).toBe(0)
    expect(await client!.sessionHistoryItem.count()).toBe(0)

    await index.sync({ ...linear, revision: 4 }, 'linear-again', {
      changes: { messages: [], activities: [], activityGroups: [], branches: [] },
      sourceFingerprint: 'original'
    })
    expect(await index.readPage(request, 'linear-again')).toMatchObject({
      revision: 4,
      hasMore: false,
      session: { messages: original }
    })
    expect(await client!.sessionHistoryItem.count({ where: { kind: 'message' } })).toBe(2)
    await expect(
      index.readPage({ ...request, beforeCursor: first.beforeCursor }, 'linear-again')
    ).rejects.toBeInstanceOf(SessionHistoryCursorStaleError)
  })

  it.each(['branch', 'frame'] as const)(
    'does not inspect display records when the graph requires complete %s navigation',
    async (kind) => {
      const index = await setup()
      let graph = createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [message('u1', 'user', 1), message('a1', 'agent', 2)],
        createdAt: 1,
        updatedAt: 2
      })
      if (kind === 'branch') {
        graph = forkEditedConversationMessage(graph, 'u1', 'edited-branch', 3)
      } else {
        graph.frames.push({
          id: 'reviewer-frame',
          kind: 'reviewer',
          parentFrameId: graph.rootFrameId,
          originMessageId: 'a1',
          originBindingState: 'validated',
          status: 'completed',
          activeBranchId: 'reviewer-branch',
          createdAt: 3
        })
        graph.branches.push({
          id: 'reviewer-branch',
          agentFrameId: 'reviewer-frame',
          createdAt: 3,
          updatedAt: 3
        })
      }
      Object.defineProperty(graph, 'messages', {
        get: () => {
          throw new Error('Unused display history was projected')
        }
      })
      await index.sync({ ...session(), conversationGraph: graph }, 'complex')
      expect(await index.readPage(request, 'complex')).toBeUndefined()
      expect(await client!.sessionHistoryIndex.count()).toBe(0)
      expect(await client!.sessionHistoryItem.count()).toBe(0)
    }
  )

  it('rolls back complex-history cleanup with its caller transaction', async () => {
    const index = await setup()
    const linear = session(1)
    await index.sync(linear, 'before')
    const graph = createLinearConversationGraph({
      sessionId: linear.id,
      messages: linear.messages,
      createdAt: 1,
      updatedAt: 200
    })
    const complex = {
      ...linear,
      revision: 2,
      conversationGraph: forkEditedConversationMessage(graph, 'prompt', 'edited-branch', 201)
    }
    const before = await index.readPage(request, 'before')
    await expect(
      client!.$transaction(async (tx) => {
        await index.sync(complex, 'after', undefined, tx)
        expect(await tx.sessionHistoryIndex.count()).toBe(0)
        expect(await tx.sessionHistoryItem.count()).toBe(0)
        throw new Error('Abort parent projection')
      })
    ).rejects.toThrow('Abort parent projection')
    expect(await index.readPage(request, 'before')).toEqual(before)
    await index.sync(complex, 'after')
    expect(await client!.sessionHistoryIndex.count()).toBe(0)
    expect(await client!.sessionHistoryItem.count()).toBe(0)
  })

  it('updates only changed payloads and deletes only removed identities during ordinary saves', async () => {
    const index = await setup()
    const full = session(3)
    await index.sync(full, 'one')
    await client!.$executeRawUnsafe(
      'CREATE TABLE ItemAudit (kind TEXT, itemId TEXT, operation TEXT)'
    )
    for (const operation of ['UPDATE', 'DELETE', 'INSERT']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW'
      await client!.$executeRawUnsafe(
        `CREATE TRIGGER audit_${operation} AFTER ${operation} ON SessionHistoryItem BEGIN INSERT INTO ItemAudit VALUES (${row}.kind, ${row}.itemId, '${operation}'); END`
      )
    }
    await index.sync(
      {
        ...full,
        revision: 2,
        messages: [full.messages[0]!, { ...full.messages[1]!, content: 'new answer' }]
      },
      'two'
    )
    expect(await client!.$queryRawUnsafe('SELECT * FROM ItemAudit')).toEqual([
      { kind: 'message', itemId: 'answer', operation: 'UPDATE' }
    ])
    await client!.$executeRawUnsafe('DELETE FROM ItemAudit')
    await index.sync({ ...full, revision: 3, artifacts: [full.artifacts![0]!] }, 'three')
    expect(await client!.$queryRawUnsafe('SELECT * FROM ItemAudit')).toEqual([
      { kind: 'message', itemId: 'answer', operation: 'UPDATE' },
      { kind: 'artifact', itemId: 'unrelated', operation: 'DELETE' }
    ])
  })

  it('uses runtime after-images without serializing unchanged history and preserves full changed records', async () => {
    const index = await setup()
    const full = session(0)
    await index.sync(full, 'one')
    const next = {
      ...full,
      revision: 2,
      messages: [
        full.messages[0]!,
        {
          ...full.messages[1]!,
          content: 'streamed answer',
          completedAt: undefined,
          status: 'streaming' as const
        }
      ]
    }
    const graph = createLinearConversationGraph({
      sessionId: full.id,
      messages: next.messages,
      createdAt: 1,
      updatedAt: 200
    })
    Object.defineProperty(next.messages[0], 'content', {
      enumerable: true,
      get: () => {
        throw new Error('Unchanged history was serialized')
      }
    })
    await index.sync(next, 'two', {
      changes: {
        messages: [graph.messages[1]!],
        activities: [],
        activityGroups: [],
        branches: []
      },
      sourceFingerprint: 'one'
    })
    expect((await index.readPage(request, 'two'))!.session.messages).toEqual([
      message('prompt', 'user', 1),
      next.messages[1]
    ])
  })

  it('joins a caller transaction and rolls back the header, payload and deletion together', async () => {
    const index = await setup()
    await index.sync(session(1), 'before')
    await expect(
      client!.$transaction(async (tx) => {
        await index.sync({ ...session(1), revision: 2, title: 'Changed' }, 'after', undefined, tx)
        await index.delete('session-1', tx)
        throw new Error('Abort parent projection')
      })
    ).rejects.toThrow('Abort parent projection')
    expect(await index.readPage(request, 'before')).toMatchObject({
      revision: 1,
      session: { title: 'History' }
    })
    await index.delete('session-1')
    expect(await index.readPage(request, 'before')).toBeUndefined()
    expect(await client!.sessionHistoryItem.count()).toBe(0)
  })

  it('builds and removes more than two SQL batches without dropping rows across the boundaries', async () => {
    const index = await setup()
    const full = session(420)
    await index.sync(full, 'many')
    expect(await client!.sessionHistoryItem.count()).toBe(425)
    const tools = new Set<string>()
    let beforeCursor: string | undefined
    do {
      const page = (await index.readPage({ ...request, beforeCursor }, 'many'))!
      expect(page.totalItems).toBe(422)
      for (const tool of page.session.activities ?? []) {
        expect(tools.has(tool.id)).toBe(false)
        tools.add(tool.id)
      }
      beforeCursor = page.beforeCursor
    } while (beforeCursor)
    expect(tools.size).toBe(420)
    await index.sync({ ...full, revision: 2, activities: [], activityGroups: [] }, 'removed')
    expect(await client!.sessionHistoryItem.count()).toBe(4)
    expect(await index.readPage(request, 'removed')).toMatchObject({
      totalItems: 2,
      hasMore: false,
      session: { activities: [], activityGroups: [] }
    })
  })

  it('reads the same indexed page after restarting the database client', async () => {
    let index = await setup()
    await index.sync(session(), 'stable')
    const before = await index.readPage(request, 'stable')
    await client!.$disconnect()
    client = createProjectDbClient(root!)
    index = new SessionHistoryProjectionRepository(async () => client!)
    expect(await index.readPage(request, 'stable')).toEqual(before)
  })
})
