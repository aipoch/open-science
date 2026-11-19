import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationActivities,
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
// Delegate to the real Prisma client while recording the exact interactive transaction options.
// This keeps the assertions on the actual call path instead of a mocked $transaction body.
const recordingClient = (
  real: PrismaClient
): {
  client: PrismaClient
  calls: { options: { maxWait?: number; timeout?: number } | undefined }[]
  inTransaction: () => boolean
} => {
  const calls: { options: { maxWait?: number; timeout?: number } | undefined }[] = []
  let active = 0
  const client = new Proxy(real, {
    get(target, property) {
      if (property === '$transaction') {
        return (operation: unknown, options?: { maxWait?: number; timeout?: number }) => {
          calls.push({ options })
          const transaction = target.$transaction.bind(target) as (
            operation: unknown,
            options?: { maxWait?: number; timeout?: number }
          ) => Promise<unknown>
          active += 1
          let pending: Promise<unknown>
          try {
            pending = transaction(operation, options)
          } catch (error) {
            active -= 1
            throw error
          }
          return pending.finally(() => {
            active -= 1
          })
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as PrismaClient
  return { client, calls, inTransaction: () => active > 0 }
}
// Track display-model reads that bypass the interactive transaction. The transaction client is
// supplied by Prisma, so any read through this proxy is an out-of-transaction planning read.
const runtimeReadScope = (
  real: PrismaClient
): { client: PrismaClient; readsOutsideTransaction: string[] } => {
  const readsOutsideTransaction: string[] = []
  let active = 0
  const client = new Proxy(real, {
    get(target, property) {
      if (property === '$transaction') {
        const transaction = target.$transaction.bind(target) as (
          operation: unknown,
          options?: { maxWait?: number; timeout?: number }
        ) => Promise<unknown>
        return (operation: unknown, options?: { maxWait?: number; timeout?: number }) => {
          active += 1
          let pending: Promise<unknown>
          try {
            pending = transaction(operation, options)
          } catch (error) {
            active -= 1
            throw error
          }
          return pending.finally(() => {
            active -= 1
          })
        }
      }
      if (property === 'sessionHistoryIndex' || property === 'sessionHistoryItem') {
        const delegate = Reflect.get(target, property, target) as object
        return new Proxy(delegate, {
          get(targetDelegate, method) {
            const value = Reflect.get(targetDelegate, method, targetDelegate)
            if (typeof value !== 'function') return value
            return (...args: unknown[]) => {
              if (active === 0) {
                readsOutsideTransaction.push(`${String(property)}.${String(method)}`)
              }
              return value.apply(targetDelegate, args)
            }
          }
        })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as PrismaClient
  return { client, readsOutsideTransaction }
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
      path: join(tmpdir(), 'artifact', 'result.txt'),
      fileUrl: pathToFileURL(join(tmpdir(), 'artifact', 'result.txt')).href
    },
    {
      id: 'unrelated',
      kind: 'managed-file',
      path: join(tmpdir(), 'artifact', 'old.txt'),
      fileUrl: pathToFileURL(join(tmpdir(), 'artifact', 'old.txt')).href
    }
  ]
})
const request = { projectId: 'project-1', sessionId: 'session-1' }

describe('SQLite Session display history', () => {
  it('restores graph-owned tool prompts from existing indexes without rewriting stored payloads', async () => {
    const index = await setup()
    const full = session(1)
    full.messages[0]!.turnOutcome = { kind: 'completed', settledAt: 200 }
    full.messages.splice(1, 0, {
      ...message('progress', 'agent', 2),
      responseToMessageId: 'prompt'
    })
    for (const tool of full.activities!) delete tool.promptMessageId
    full.conversationGraph = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: full.id,
        messages: full.messages,
        createdAt: 1,
        updatedAt: 200
      }),
      full.activities!,
      full.activityGroups!
    )
    await index.sync(full, 'graph-source')
    const stored = await client!.sessionHistoryItem.findUniqueOrThrow({
      where: {
        sessionId_kind_itemId: { sessionId: full.id, kind: 'activity', itemId: 'tool-0' }
      }
    })
    expect(stored.promptMessageId).toBe('prompt')
    expect(JSON.parse(stored.payloadJson)).not.toHaveProperty('promptMessageId')
    const page = (await index.readPage(request, 'graph-source'))!
    expect(page.session.conversationGraph).toBeUndefined()
    expect(page.session.activities).toEqual([{ ...full.activities![0], promptMessageId: 'prompt' }])
    expect(
      await client!.sessionHistoryItem.findUniqueOrThrow({
        where: {
          sessionId_kind_itemId: { sessionId: full.id, kind: 'activity', itemId: 'tool-0' }
        }
      })
    ).toEqual(stored)
  })

  it('does not turn inferred legacy index prompts into tool ownership', async () => {
    const index = await setup()
    const full = session(1)
    delete full.activities![0]!.promptMessageId
    await index.sync(full, 'legacy-source')
    const stored = await client!.sessionHistoryItem.findUniqueOrThrow({
      where: {
        sessionId_kind_itemId: { sessionId: full.id, kind: 'activity', itemId: 'tool-0' }
      }
    })
    expect(stored.promptMessageId).toBe('prompt')
    expect((await index.readPage(request, 'legacy-source'))!.session.activities).toEqual(
      full.activities
    )
  })

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
      'conversationGraph',
      'recordProblems'
    ]) {
      expect(header).not.toHaveProperty(field)
    }
  })

  it('keeps transient record problems out of new headers and older derived indexes', async () => {
    const index = await setup()
    const full: PersistedChatSession = { ...session(1), recordProblems: ['size-limit'] }
    await index.sync(full, 'source')
    const stored = await client!.sessionHistoryIndex.findUniqueOrThrow({
      where: { sessionId: full.id }
    })
    expect(JSON.parse(stored.headerJson)).not.toHaveProperty('recordProblems')
    expect((await index.readPage(request, 'source'))!.session).not.toHaveProperty('recordProblems')

    // Older indexes persisted the same transient Main fact in headerJson. Excluding it on read
    // keeps them usable without a rebuild or a second display-only schema.
    await client!.sessionHistoryIndex.update({
      where: { sessionId: full.id },
      data: {
        headerJson: JSON.stringify({
          ...JSON.parse(stored.headerJson),
          recordProblems: ['missing-record']
        })
      }
    })
    expect((await index.readPage(request, 'source'))!.session).not.toHaveProperty('recordProblems')
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

  it('validates independent runtime syncs inside the transaction and serializes new rows there', async () => {
    await setup()
    const scope = runtimeReadScope(client!)
    const index = new SessionHistoryProjectionRepository(async () => scope.client)
    const full = session(0)
    await index.sync(full, 'one')
    const added = {
      id: 'late-artifact',
      kind: 'managed-file' as const,
      path: join(tmpdir(), 'artifact', 'late.txt'),
      fileUrl: pathToFileURL(join(tmpdir(), 'artifact', 'late.txt')).href
    }
    const next = {
      ...full,
      revision: 2,
      title: 'Runtime title',
      artifacts: [...full.artifacts!, added]
    }
    scope.readsOutsideTransaction.length = 0
    await index.sync(next, 'two', {
      changes: { messages: [], activities: [], activityGroups: [], branches: [] },
      sourceFingerprint: 'one'
    })
    expect(scope.readsOutsideTransaction).toEqual([])
    const stored = await client!.sessionHistoryItem.findUnique({
      where: {
        sessionId_kind_itemId: {
          sessionId: full.id,
          kind: 'artifact',
          itemId: added.id
        }
      }
    })
    expect(stored?.payloadJson).toContain('/artifact/late.txt')
    expect(await index.readPage(request, 'two')).toMatchObject({
      revision: 2,
      session: { title: 'Runtime title' }
    })
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

  it('passes the explicit sync budget and serializes a full rebuild before the transaction', async () => {
    await setup()
    const recorder = recordingClient(client!)
    const index = new SessionHistoryProjectionRepository(async () => recorder.client)
    const full = session(2)
    Object.defineProperty(full.messages[1]!, 'content', {
      configurable: true,
      enumerable: true,
      get: () => {
        if (recorder.inTransaction())
          throw new Error('Full rebuild payload was serialized inside the transaction')
        return 'answer body'
      }
    })
    await index.sync(full, 'outside')
    expect(recorder.calls).toEqual([{ options: { maxWait: 30_000, timeout: 10_000 } }])
    const page = await new SessionHistoryProjectionRepository(async () => client!).readPage(
      request,
      'outside'
    )
    expect(page).toMatchObject({
      totalItems: 4,
      session: {
        messages: [
          message('prompt', 'user', 1),
          { ...message('answer', 'agent', 150), content: 'answer body' }
        ]
      }
    })
  })

  it('passes the thirty-second admission budget to real page-read transactions', async () => {
    await setup()
    await new SessionHistoryProjectionRepository(async () => client!).sync(
      session(2),
      'page-budget'
    )
    const recorder = recordingClient(client!)
    const index = new SessionHistoryProjectionRepository(async () => recorder.client)
    const page = await index.readPage(request, 'page-budget')
    expect(page).toMatchObject({ totalItems: 4, hasMore: false })
    expect(recorder.calls).toEqual([{ options: { maxWait: 30_000 } }])
  })

  it('fails invalid display records before writing and rolls back rejected SQLite batches', async () => {
    const index = await setup()
    expect(await client!.sessionHistoryIndex.count()).toBe(0)
    expect(await client!.sessionHistoryItem.count()).toBe(0)
    const invalid = {
      ...session(1),
      messages: [
        ...session(1).messages,
        { id: 'unreadable', role: 'agent', createdAt: 200 } as unknown as PersistedChatMessage
      ]
    } satisfies PersistedChatSession
    await expect(index.sync(invalid, 'failed-rebuild')).rejects.toThrow('invalid display record')
    expect(await client!.sessionHistoryIndex.count()).toBe(0)
    expect(await client!.sessionHistoryItem.count()).toBe(0)
    expect(await index.readPage(request, 'failed-rebuild')).toBeUndefined()

    await index.sync(session(1), 'before')
    const before = await index.readPage(request, 'before')
    expect(before).toMatchObject({ revision: 1, totalItems: 3 })
    await client!.$executeRawUnsafe(
      "CREATE TRIGGER reject_history_insert BEFORE INSERT ON SessionHistoryItem BEGIN SELECT RAISE(ABORT, 'rejected history item'); END"
    )
    try {
      // session(2) adds a tool row, so the index upsert and the rejected item batch must roll
      // back together instead of leaving a newer header over the previous page.
      await expect(index.sync({ ...session(2), revision: 2 }, 'after')).rejects.toThrow()
    } finally {
      await client!.$executeRawUnsafe('DROP TRIGGER reject_history_insert')
    }
    expect(await index.readPage(request, 'before')).toEqual(before)
    expect(
      await client!.sessionHistoryIndex.findUniqueOrThrow({ where: { sessionId: 'session-1' } })
    ).toMatchObject({ revision: 1n, sourceFingerprint: 'before' })
    expect(await index.readPage(request, 'after')).toBeUndefined()

    await index.sync({ ...session(2), revision: 2 }, 'after')
    expect(await index.readPage(request, 'after')).toMatchObject({ revision: 2, totalItems: 4 })
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
