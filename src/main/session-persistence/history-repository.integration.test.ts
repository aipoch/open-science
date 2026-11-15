import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createSessionFile,
  materializeSessionConversationGraph,
  normalizeSessionFile,
  SESSION_SIZE_LIMIT_ERROR_CODE,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { SessionHistoryCursorStaleError } from '../../shared/session-history'
import { applyRuntimeSessionEventsWithChanges } from '../../shared/runtime-session-projection'
import {
  forkEditedConversationMessage,
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'
import { SessionProjectionRepository } from './projection'
import { loadSessionMutationAuthority, SessionRepository } from './repository'
import { sessionJournalPath } from './journal'

let root: string
let client: PrismaClient
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
const setup = async (): Promise<SessionRepository> => {
  root = await mkdtemp(join(tmpdir(), 'session-history-repository-'))
  initDataRoot(root)
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project', name: 'Research' } })
  return reopen()
}
const reopen = (): SessionRepository =>
  new SessionRepository(root, {}, new SessionProjectionRepository(async () => client))
const request = { projectId: 'project', sessionId: 'session' }
const logicalPath = (): string => join(root, 'sessions', 'project', 'session.json')
const fixture = (): PersistedChatSession => ({
  id: 'session',
  projectId: 'project',
  title: 'Research history',
  cwd: '',
  status: 'idle',
  createdAt: 1,
  updatedAt: 200,
  messages: [
    {
      id: 'prompt',
      role: 'user',
      content: 'Analyze the evidence',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'answer',
      role: 'agent',
      responseToMessageId: 'prompt',
      content: 'Answer',
      status: 'complete',
      eventIds: [],
      createdAt: 150,
      updatedAt: 150
    }
  ],
  activities: Array.from({ length: 120 }, (_, i) => ({
    id: `tool-${i}`,
    kind: 'tool',
    title: `Read evidence ${i}`,
    status: 'completed',
    sortIndex: i,
    promptMessageId: 'prompt',
    eventIds: [],
    createdAt: i + 2,
    updatedAt: i + 2,
    rawOutput: { text: `Evidence ${i}` }
  }))
})

it('returns old JSON as a complete conversation without building an index or migrating it', async () => {
  const repository = await setup()
  const raw = JSON.stringify(createSessionFile(fixture()), null, 2)
  await mkdir(join(root, 'sessions', 'project'), { recursive: true })
  await writeFile(logicalPath(), raw)
  const full = (await repository.loadSession('project', 'session'))!
  const page = (await repository.loadSessionHistoryPage({ ...request, limit: 1 }))!
  expect(page.complete).toBe(true)
  expect(page.session).toEqual(full)
  expect(page.session.conversationGraph).toBeDefined()
  expect(page.totalItems).toBe(122)
  expect(page.hasMore).toBe(false)
  expect(page.beforeCursor).toBeUndefined()
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
  expect(await readFile(logicalPath(), 'utf8')).toBe(raw)
  await expect(readFile(sessionJournalPath(logicalPath()))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  expect((await reopen().loadSessionHistoryPage(request))!.session).toEqual(full)
  expect(await client.sessionHistoryIndex.count()).toBe(0)

  const saved = await repository.saveSession({ ...full, title: 'Continued' }, full.revision)
  const continued = (await reopen().loadSessionHistoryPage(request))!
  expect(continued.complete).toBe(true)
  expect(continued.hasMore).toBe(false)
  expect(continued.session).toEqual(saved)
  expect(await readdir(join(root, 'sessions', 'project'))).toEqual(['session.json'])
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
})

it.each(['missing', 'duplicate'] as const)(
  'keeps historical JSON during startup repair of %s Session numbers',
  async (kind) => {
    const repository = await setup()
    const directory = join(root, 'sessions', 'project')
    await mkdir(directory, { recursive: true })
    const first = { ...fixture(), number: kind === 'duplicate' ? 7 : undefined }
    const second = { ...first, id: 'second', createdAt: 2 }
    for (const session of [first, second]) {
      await writeFile(
        join(directory, `${session.id}.json`),
        JSON.stringify(createSessionFile(session))
      )
    }
    const initialized = await repository.ensureSessionProjection(() => repository.loadAll())
    expect(initialized.sessions).toHaveLength(2)
    expect(new Set(initialized.sessions.map(({ number }) => number)).size).toBe(2)
    for (const session of [first, second]) {
      const page = (await reopen().loadSessionHistoryPage({ ...request, sessionId: session.id }))!
      const expected = normalizeSessionFile(createSessionFile(session))!
      expect(page.complete).toBe(true)
      expect(page.session.number).toBeGreaterThan(0)
      expect(page.session.messages).toEqual(expected.messages)
      expect(page.session.activities).toEqual(expected.activities)
      expect(page.session.conversationGraph).toEqual(expected.conversationGraph)
    }
    expect((await readdir(directory)).sort()).toEqual(['second.json', 'session.json'])
    expect(await client.sessionHistoryIndex.count()).toBe(0)
    expect(await client.sessionHistoryItem.count()).toBe(0)
  }
)

it('repairs pending projection state from committed legacy JSON without changing its format', async () => {
  const repository = await setup()
  const directory = join(root, 'sessions', 'project')
  await mkdir(directory, { recursive: true })
  await writeFile(logicalPath(), JSON.stringify(createSessionFile({ ...fixture(), number: 1 })))
  await repository.ensureSessionProjection(() => repository.loadAll())
  const full = (await repository.loadSession('project', 'session'))!
  const projection = new SessionProjectionRepository(async () => client)
  vi.spyOn(projection, 'commitSave').mockRejectedValueOnce(new Error('Injected projection failure'))
  const failing = new SessionRepository(root, {}, projection)
  await expect(
    failing.saveSession({ ...full, title: 'Committed before projection failure' }, full.revision)
  ).rejects.toMatchObject({ name: 'SessionProjectionAfterCommitError' })
  expect(await projection.pending()).toEqual([
    { projectId: 'project', sessionId: 'session', operation: 'save' }
  ])

  const cold = reopen()
  await cold.ensureSessionProjection(() => cold.loadAll())
  expect(await projection.pending()).toEqual([])
  const page = (await cold.loadSessionHistoryPage(request))!
  expect(page.complete).toBe(true)
  expect(page.session.title).toBe('Committed before projection failure')
  expect(page.session.messages).toEqual(full.messages)
  expect(page.session.activities).toEqual(full.activities)
  expect(page.session.conversationGraph).toEqual(full.conversationGraph)
  expect(await client.session.findUnique({ where: { id: 'session' } })).toMatchObject({
    title: 'Committed before projection failure'
  })
  expect(await readdir(directory)).toEqual(['session.json'])
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
})

it('rejects an oversized formatted JSON save before allocating a number or pending projection', async () => {
  await setup()
  const source = fixture()
  const directory = join(root, 'sessions', 'project')
  await mkdir(directory, { recursive: true })
  const raw = JSON.stringify(createSessionFile(source))
  await writeFile(logicalPath(), raw)
  const nextDocument = createSessionFile({
    ...source,
    revision: 1,
    number: Number.MAX_SAFE_INTEGER
  })
  const compactBytes = Buffer.byteLength(JSON.stringify(nextDocument))
  const maxSessionBytes = compactBytes + 1
  expect(Buffer.byteLength(raw)).toBeLessThan(maxSessionBytes)
  expect(Buffer.byteLength(JSON.stringify(nextDocument, null, 2))).toBeGreaterThan(maxSessionBytes)
  const projection = new SessionProjectionRepository(async () => client)
  const prepareSave = vi.spyOn(projection, 'prepareSave')
  const repository = new SessionRepository(root, { maxSessionBytes }, projection)

  await expect(repository.saveSession(source)).rejects.toMatchObject({
    code: SESSION_SIZE_LIMIT_ERROR_CODE
  })
  expect(prepareSave).not.toHaveBeenCalled()
  expect(await projection.pending()).toEqual([])
  expect(await client.session.count()).toBe(0)
  expect(await client.sessionNumberSequence.count()).toBe(0)
  expect(await readFile(logicalPath(), 'utf8')).toBe(raw)
  expect(await readdir(directory)).toEqual(['session.json'])
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
})

it('serves mixed JSON and JSONL through the same history API and saves each in its existing format', async () => {
  const repository = await setup()
  const directory = join(root, 'sessions', 'project')
  await mkdir(directory, { recursive: true })
  await writeFile(logicalPath(), JSON.stringify(createSessionFile({ ...fixture(), number: 1 })))
  await repository.ensureSessionProjection(() => repository.loadAll())
  const newSession = await repository.saveSession({ ...fixture(), id: 'new-session' })
  const legacy = (await repository.loadSessionHistoryPage({ ...request, limit: 1 }))!
  const recent = (await repository.loadSessionHistoryPage({
    ...request,
    sessionId: newSession.id,
    limit: 1
  }))!
  expect(legacy).toMatchObject({ complete: true, hasMore: false, totalItems: 122 })
  expect(recent.complete).toBeUndefined()
  expect(recent).toMatchObject({ hasMore: true, totalItems: 122 })
  await repository.saveSession({ ...legacy.session, title: 'Legacy continued' }, legacy.revision)
  await repository.saveSession({ ...newSession, title: 'New continued' }, newSession.revision)
  const cold = reopen()
  expect(await cold.loadSessionHistoryPage(request)).toMatchObject({
    complete: true,
    hasMore: false,
    session: { title: 'Legacy continued', messages: legacy.session.messages }
  })
  expect(
    await cold.loadSessionHistoryPage({ ...request, sessionId: newSession.id, limit: 1 })
  ).toMatchObject({
    hasMore: true,
    session: { title: 'New continued' }
  })
  expect((await readdir(directory)).sort()).toEqual(['new-session.jsonl', 'session.json'])
  expect(await client.sessionHistoryIndex.findMany({ select: { sessionId: true } })).toEqual([
    { sessionId: 'new-session' }
  ])
  expect(await client.sessionHistoryItem.count({ where: { sessionId: 'session' } })).toBe(0)
})

it('reads indexed JSONL pages without loading the complete conversation', async () => {
  const repository = await setup()
  await repository.saveSession(fixture())
  const first = (await repository.loadSessionHistoryPage(request))!
  expect(first.complete).toBeUndefined()
  expect(first.totalItems).toBe(122)
  expect(first.hasMore).toBe(true)
  const full = (await repository.loadSession('project', 'session'))!
  const cold = reopen()
  const fullRead = vi
    .spyOn(cold, 'loadSession')
    .mockRejectedValue(new Error('Unexpected full history read'))
  const last = (await cold.loadSessionHistoryPage({
    ...request,
    beforeCursor: first.beforeCursor
  }))!
  expect(last.hasMore).toBe(false)
  expect(fullRead).not.toHaveBeenCalled()
  const tools = new Map(
    [...first.session.activities!, ...last.session.activities!].map((item) => [item.id, item])
  )
  expect([...tools.values()].sort((a, b) => a.sortIndex - b.sortIndex)).toEqual(full.activities)
})

it.each(['branch', 'frame'] as const)(
  'keeps the complete JSONL graph when a cold display read needs %s navigation',
  async (kind) => {
    await setup()
    const projection = new SessionProjectionRepository(async () => client)
    const sync = vi.spyOn(projection.history, 'sync')
    const repository = new SessionRepository(root, {}, projection)
    const source = materializeSessionConversationGraph(fixture())
    let graph = source.conversationGraph!
    if (kind === 'branch') {
      graph = synchronizeActiveConversationMessages(
        forkEditedConversationMessage(graph, 'prompt', 'revised-branch', 201),
        [{ ...source.messages[0]!, id: 'revised', content: 'Revised prompt', createdAt: 201 }],
        201
      )
    } else {
      graph.frames.push({
        id: 'reviewer-frame',
        kind: 'reviewer',
        parentFrameId: graph.rootFrameId,
        originMessageId: 'answer',
        originBindingState: 'validated',
        status: 'completed',
        activeBranchId: 'reviewer-branch',
        createdAt: 201
      })
      graph.branches.push({
        id: 'reviewer-branch',
        agentFrameId: 'reviewer-frame',
        createdAt: 201,
        updatedAt: 201
      })
    }
    await repository.saveSession({
      ...source,
      conversationGraph: graph,
      messages: resolveActiveConversationMessages(graph).map(projectConversationMessage),
      ...resolveActiveConversationActivities(graph)
    })
    const expected = await repository.loadSession('project', 'session')
    const sourceFingerprint = sync.mock.calls[0]![1]
    expect(await client.sessionHistoryIndex.count()).toBe(0)
    expect(await client.sessionHistoryItem.count()).toBe(0)
    sync.mockClear()
    const cold = new SessionRepository(root, {}, projection)
    const fullRead = vi.spyOn(cold, 'loadSession')
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        // Simulate an index retained from the version that indexed complex graphs. Its older
        // scope cannot prove that a display page preserves all branch/Frame navigation.
        await client.sessionHistoryIndex.create({
          data: {
            sessionId: 'session',
            projectId: 'project',
            revision: BigInt(expected!.revision!),
            sourceFingerprint,
            scopeKey: JSON.stringify([
              graph.activeFrameId,
              graph.frames.find(({ id }) => id === graph.activeFrameId)!.activeBranchId
            ]),
            headerJson: JSON.stringify({
              ...expected,
              messages: undefined,
              activities: undefined,
              activityGroups: undefined,
              artifacts: undefined,
              conversationGraph: undefined
            }),
            totalItems: expected!.messages.length + (expected!.activities?.length ?? 0)
          }
        })
      }
      const page = (await cold.loadSessionHistoryPage({ ...request, limit: 1 }))!
      expect(page.complete).toBe(true)
      expect(page.session).toEqual(expected)
      expect(page.session.conversationGraph!.branches).toHaveLength(2)
      expect(page.hasMore).toBe(false)
      expect(page.beforeCursor).toBeUndefined()
      expect(fullRead).toHaveBeenCalledTimes(attempt + 1)
      expect(sync).not.toHaveBeenCalled()
    }
  }
)

it('admits an older unclassified linear index through full decoding before reusing pages', async () => {
  const repository = await setup()
  await repository.saveSession(fixture())
  const index = await client.sessionHistoryIndex.findUniqueOrThrow({
    where: { sessionId: 'session' }
  })
  await client.sessionHistoryIndex.update({
    where: { sessionId: 'session' },
    data: { scopeKey: JSON.stringify(JSON.parse(index.scopeKey).slice(0, 2)) }
  })
  const cold = reopen()
  const fullRead = vi.spyOn(cold, 'loadSession')
  const page = (await cold.loadSessionHistoryPage(request))!
  expect(fullRead).toHaveBeenCalledTimes(1)
  expect(page.complete).toBeUndefined()
  expect(page.hasMore).toBe(true)
  expect(await cold.loadSessionHistoryPage(request)).toEqual(page)
  expect(fullRead).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  'binds runtime index updates to their previous source (external replacement: %s)',
  async (replaced) => {
    await setup()
    const projection = new SessionProjectionRepository(async () => client)
    const repository = new SessionRepository(
      root,
      { hasLiveRuntimeSession: () => true },
      projection
    )
    const original = materializeSessionConversationGraph({
      ...fixture(),
      agentFrameworkId: 'codex',
      status: 'running',
      activeRun: { promptMessageId: 'prompt', startedAt: 200 },
      messages: [
        { ...fixture().messages[0], id: 'history', content: 'Original history' },
        { ...fixture().messages[0], createdAt: 200, updatedAt: 200 }
      ],
      activities: []
    })
    const saved = await repository.saveSession(original)
    const indexedSource = (
      await client.sessionHistoryIndex.findUniqueOrThrow({
        where: { sessionId: saved.id }
      })
    ).sourceFingerprint
    const external = {
      ...saved,
      messages: saved.messages.map((message) =>
        message.id === 'history' ? { ...message, content: 'External history' } : message
      ),
      conversationGraph: {
        ...saved.conversationGraph!,
        messages: saved.conversationGraph!.messages.map((message) =>
          message.id === 'history' ? { ...message, content: 'External history' } : message
        )
      }
    }
    if (replaced) {
      await writeFile(
        sessionJournalPath(logicalPath()),
        JSON.stringify({ type: 'session_snapshot', document: createSessionFile(external) }) + '\n'
      )
    }
    const loaded = await loadSessionMutationAuthority(repository, 'project', 'session')
    expect(loaded.status).toBe('found')
    if (loaded.status !== 'found') throw new Error('Expected external authority')
    const previous = loaded.session
    expect(previous.revision).toBe(saved.revision)
    const prompt = previous.conversationGraph!.messages.find(({ id }) => id === 'prompt')!
    const reduced = applyRuntimeSessionEventsWithChanges(
      previous,
      {
        promptMessageId: 'prompt',
        agentFrameId: prompt.agentFrameId,
        messageBranchId: prompt.introducedOnBranchId,
        runtimeSegmentId: prompt.runtimeSegmentId!
      },
      [
        {
          id: 'new-event',
          kind: 'message',
          level: 'info',
          timestamp: 201,
          sessionId: 'session',
          role: 'assistant',
          messageId: 'new-answer',
          text: 'New answer'
        }
      ]
    )
    expect(reduced.changes).toBeDefined()
    expect(reduced.changes!.messages.map(({ id }) => id)).not.toContain('history')
    const sync = vi.spyOn(projection.history, 'sync')
    const continued = await repository.saveSession(reduced.session, previous.revision, {
      runtimeChanges: { previous, changes: reduced.changes! }
    })
    expect(sync.mock.calls[0]?.[2]).toBeDefined()
    const runtimeSource = sync.mock.calls[0]![2]!.sourceFingerprint
    if (replaced) expect(runtimeSource).not.toBe(indexedSource)
    else expect(runtimeSource).toBe(indexedSource)
    const expectedHistory = replaced ? 'External history' : 'Original history'
    const full = await loadSessionMutationAuthority(repository, 'project', 'session')
    expect(
      full.status === 'found' && full.session.messages.find(({ id }) => id === 'history')?.content
    ).toBe(expectedHistory)
    const page = (await repository.loadSessionHistoryPage(request))!
    expect(page.revision).toBe(continued.revision)
    expect(page.session.messages.find(({ id }) => id === 'history')?.content).toBe(expectedHistory)
    expect(page.session.messages.at(-1)?.content).toBe('New answer')
  }
)

it('invalidates a cursor on a new save and recovers an index failure from the committed JSONL', async () => {
  const repository = await setup()
  const saved = await repository.saveSession(fixture())
  const first = (await repository.loadSessionHistoryPage(request))!
  const projection = new SessionProjectionRepository(async () => client)
  vi.spyOn(projection.history, 'sync').mockRejectedValueOnce(
    new Error('Injected index transaction failure')
  )
  const failing = new SessionRepository(root, {}, projection)
  await expect(
    failing.saveSession({ ...saved, title: 'New evidence' }, saved.revision)
  ).rejects.toMatchObject({ name: 'SessionProjectionAfterCommitError' })
  const cold = reopen()
  await expect(
    cold.loadSessionHistoryPage({ ...request, beforeCursor: first.beforeCursor })
  ).rejects.toBeInstanceOf(SessionHistoryCursorStaleError)
  const latest = (await cold.loadSessionHistoryPage(request))!
  expect(latest.session.title).toBe('New evidence')
  expect(latest.revision).toBe(saved.revision! + 1)
  expect(latest.totalItems).toBe(122)
})

it('rebuilds after a torn append, but never serves a stale index over a complete corrupt record', async () => {
  const repository = await setup()
  const saved = await repository.saveSession(fixture())
  const log = sessionJournalPath(logicalPath())
  await appendFile(log, '{"type":"session_up')
  const torn = await readFile(log, 'utf8')
  const recovered = (await reopen().loadSessionHistoryPage(request))!
  expect(recovered.revision).toBe(saved.revision)
  expect(await readFile(log, 'utf8')).toBe(torn)
  await reopen().saveSession({ ...saved, title: 'Continued' }, saved.revision)
  expect((await reopen().loadSessionHistoryPage(request))!.session.title).toBe('Continued')
  await appendFile(log, '{invalid complete record}\n')
  await expect(reopen().loadSessionHistoryPage(request)).resolves.toBeUndefined()
  expect(await readFile(log, 'utf8')).toContain('{invalid complete record}\n')
})

it('uses the existing restart decoder before displaying a persisted unfinished turn', async () => {
  const repository = await setup()
  const active = fixture()
  active.status = 'running'
  active.messages[1].status = 'streaming'
  await repository.saveSession(active)
  const cold = reopen()
  const full = (await cold.loadSession('project', 'session'))!
  const page = (await cold.loadSessionHistoryPage(request))!
  expect(page.session.status).toBe(full.status)
  expect(page.session.messages.find((item) => item.id === 'answer')).toEqual(full.messages[1])
})

it('removes derived conversation bodies after Session and Project deletion', async () => {
  const repository = await setup()
  await repository.saveSession(fixture())
  expect(await client.sessionHistoryItem.count()).toBeGreaterThan(0)
  await repository.deleteSession('project', 'session')
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
  await repository.saveSession({ ...fixture(), id: 'another' })
  expect(await client.sessionHistoryItem.count()).toBeGreaterThan(0)
  await repository.deleteProjectSessions('project')
  await repository.completeProjectSessionDeletion('project')
  expect(await client.sessionHistoryIndex.count()).toBe(0)
  expect(await client.sessionHistoryItem.count()).toBe(0)
})
