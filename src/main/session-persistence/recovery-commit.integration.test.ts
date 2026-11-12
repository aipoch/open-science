import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { initDataRoot } from '../storage-root'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionRepository, loadSessionMutationAuthority } from './repository'
import { SessionProjectionRepository } from './projection'
import { RuntimeSessionOwner } from './runtime-session-owner'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'

const roots: string[] = []
const clients: PrismaClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.$disconnect()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const session = (id = 'session', projectId = 'project'): PersistedChatSession => ({
  id,
  projectId,
  title: 'Original title',
  cwd: '/workspace',
  status: 'running',
  activeRun: { promptMessageId: 'prompt', startedAt: 1 },
  messages: [
    {
      id: 'prompt',
      role: 'user',
      content: 'Original question',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  createdAt: 1,
  updatedAt: 1
})

type RecoveryHarness = {
  root: string
  client: PrismaClient
  repository: SessionRepository
  coordinator: SessionPersistenceCoordinator
  projection: SessionProjectionRepository
  initial: PersistedChatSession
  events: unknown[]
}

const harness = async (
  dependencies: NonNullable<ConstructorParameters<typeof SessionRepository>[1]> = {}
): Promise<RecoveryHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'session-recovery-commit-'))
  roots.push(root)
  initDataRoot(root)
  const client = createProjectDbClient(root)
  clients.push(client)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project', name: 'Research' } })
  const projection = new SessionProjectionRepository(async () => client)
  const repository = new SessionRepository(root, dependencies, projection)
  const initial = await repository.saveSession(session())
  await projection.replaceAll([initial])
  const fileIndex: SessionFileIndex = {
    syncSession: async () => [],
    softDeleteSession: async () => 'unused',
    restoreSession: async () => undefined,
    softDeleteProject: async () => 'unused',
    reconcileProjectSessions: async () => undefined,
    reconcileActiveSessions: async () => undefined,
    markReconciliationIncomplete: () => undefined
  }
  const events: unknown[] = []
  const record = (_message: string, data?: unknown): void => {
    events.push(data)
  }
  const coordinator = new SessionPersistenceCoordinator(
    repository,
    fileIndex,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { debug: record, info: record, warn: record, error: record }
  )
  return { root, client, repository, coordinator, projection, initial, events }
}

it('rejects deferred recovery after a newer save and preserves its messages and metadata', async () => {
  const h = await harness()
  const prepared = await h.coordinator.prepareSessionRecovery('project', 'session')
  expect(prepared).toBeDefined()
  const newer = await h.repository.saveSession(
    {
      ...session(),
      title: 'Newer title',
      messages: [
        ...session().messages,
        {
          id: 'new-message',
          role: 'agent',
          content: 'Newer answer',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      updatedAt: 2
    },
    h.initial.revision
  )

  expect(await loadSessionMutationAuthority(h.repository, 'project', 'session')).toMatchObject({
    status: 'found'
  })
  await expect(h.coordinator.commitSessionRecovery(prepared!)).rejects.toMatchObject({
    name: 'SessionRevisionConflictError'
  })
  expect(await loadSessionMutationAuthority(h.repository, 'project', 'session')).toMatchObject({
    status: 'found',
    session: {
      revision: newer.revision,
      title: 'Newer title',
      messages: [{ content: 'Original question' }, { content: 'Newer answer' }]
    }
  })
  expect(await h.repository.loadSessionSummaries()).toMatchObject([
    {
      revision: newer.revision,
      title: 'Newer title'
    }
  ])
  const recovered = await h.coordinator.recoverStartupSession('project', 'session')
  expect(recovered).toMatchObject({ title: 'Newer title', status: 'error' })
  expect(recovered?.messages.map(({ content }) => content)).toEqual([
    'Original question',
    'Newer answer'
  ])
  expect(
    JSON.parse(await readFile(join(h.root, 'sessions/project/session.json'), 'utf8')).session
  ).toMatchObject({ title: 'Newer title', status: 'error' })
})

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

it('commits an active terminal in the same Project while historical recovery reads are delayed', async () => {
  const entered = deferred()
  const release = deferred()
  let delayRead = false
  const h = await harness({
    hasLiveRuntimeSession: (_projectId, sessionId) => sessionId === 'active',
    hasActiveRuntimePrompt: (_projectId, sessionId) => sessionId === 'active',
    readSessionFile: async (path) => {
      if (delayRead && basename(path) === 'session.json') {
        entered.resolve()
        await release.promise
      }
      return readFile(path, 'utf8')
    }
  })
  const active = await h.repository.saveSession(
    materializeSessionConversationGraph(session('active'))
  )
  const graph = active.conversationGraph!
  const scope = {
    projectId: 'project',
    sessionId: 'active',
    promptMessageId: 'prompt',
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    executionId: 'execution'
  }
  const owner = new RuntimeSessionOwner({
    loadSession: (identity) =>
      h.coordinator.loadSessionForContinuation(identity.projectId, identity.sessionId),
    mutateSession: (identity, mutate, onJsonCommitted) =>
      h.coordinator.mutateRuntimeSession(identity, mutate, onJsonCommitted),
    finalizeArtifacts: async () => [],
    scheduleFlush: () => () => undefined,
    now: () => 10
  })
  await owner.begin(scope)
  delayRead = true
  const preparation = h.coordinator.prepareSessionRecovery('project', 'session')
  await entered.promise
  let committed = false
  const terminal = owner.commitTerminal(
    {
      id: 'terminal',
      timestamp: 20,
      sessionId: 'active',
      promptMessageId: 'prompt',
      promptExecutionId: 'execution',
      kind: 'stop',
      level: 'info',
      text: 'end_turn'
    },
    () => {
      committed = true
    }
  )
  try {
    await expect.poll(() => committed, { timeout: 1500 }).toBe(true)
    expect(await loadSessionMutationAuthority(h.repository, 'project', 'active')).toMatchObject({
      status: 'found',
      session: { status: 'idle' }
    })
  } finally {
    delayRead = false
    release.resolve()
    await Promise.all([preparation, terminal])
    await h.coordinator.readSessionSnapshot('project', 'active')
  }
})

it.each([1, 2])('bounds recovery retries when authority advances %i time(s)', async (conflicts) => {
  let armed = false
  let recoveryReads = 0
  let advances = 0
  const h = await harness({
    readSessionFile: async (path) => {
      if (armed && basename(path) === 'session.json') {
        recoveryReads += 1
        if ((recoveryReads === 2 || recoveryReads === 4) && advances < conflicts) {
          const document = JSON.parse(await readFile(path, 'utf8'))
          advances += 1
          document.session.revision += 1
          document.session.title = `Concurrent title ${advances}`
          await writeFile(path, JSON.stringify(document))
        }
      }
      return readFile(path, 'utf8')
    }
  })
  armed = true
  const recovering = h.coordinator.recoverStartupSession('project', 'session')
  if (conflicts === 1) {
    await expect(recovering).resolves.toMatchObject({
      title: 'Concurrent title 1',
      status: 'error'
    })
  } else {
    await expect(recovering).rejects.toMatchObject({ name: 'SessionRevisionConflictError' })
    expect(advances).toBe(2)
  }
  armed = false
  expect(h.events).toContainEqual(
    expect.objectContaining({
      operation: 'session-recovery',
      mode: 'startup',
      revisionConflicts: conflicts,
      status: conflicts === 1 ? 'ready' : 'deferred'
    })
  )
  expect(h.events).toContainEqual(
    expect.objectContaining({
      mode: 'commit',
      phase: 'revalidate-authority',
      queueWaitMs: expect.any(Number)
    })
  )
  expect(await loadSessionMutationAuthority(h.repository, 'project', 'session')).toMatchObject({
    status: 'found',
    session: { title: `Concurrent title ${conflicts}` }
  })
})

it('keeps temporary authority untouched until the guarded recovery commit', async () => {
  const h = await harness()
  const primary = join(h.root, 'sessions/project/session.json')
  const temporary = `${primary}.123.tmp`
  const contents = await readFile(primary, 'utf8')
  await writeFile(temporary, contents)
  await rm(primary)

  const prepared = await h.coordinator.prepareSessionRecovery('project', 'session')
  expect(prepared).toEqual({
    status: 'repair-required',
    projectId: 'project',
    sessionId: 'session'
  })
  await expect(readFile(primary, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(temporary, 'utf8')).toBe(contents)
  await expect(h.coordinator.commitSessionRecovery(prepared!)).resolves.toMatchObject({
    id: 'session',
    status: 'error'
  })
  expect(await loadSessionMutationAuthority(h.repository, 'project', 'session')).toMatchObject({
    status: 'found',
    session: { id: 'session', status: 'error' }
  })
})

it('does not promote an older temp past an unsupported authority barrier', async () => {
  const h = await harness()
  const primary = join(h.root, 'sessions/project/session.json')
  const compatible = `${primary}.123.tmp`
  const future = `${primary}.124.tmp`
  await writeFile(compatible, await readFile(primary, 'utf8'))
  await writeFile(future, JSON.stringify({ version: 999, session: { id: 'session' } }))
  await rm(primary)

  const prepared = await h.coordinator.prepareSessionRecovery('project', 'session')
  await expect(h.coordinator.commitSessionRecovery(prepared!)).rejects.toThrow('unreadable')
  await expect(readFile(primary, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(future, 'utf8')).resolves.toContain('999')
  await expect(readFile(compatible, 'utf8')).resolves.toContain('Original question')
})

it('rejects prepared recovery after deletion without resurrecting revision-zero authority', async () => {
  const h = await harness()
  const primary = join(h.root, 'sessions/project/session.json')
  const document = JSON.parse(await readFile(primary, 'utf8'))
  delete document.session.revision
  await writeFile(primary, JSON.stringify(document))
  const prepared = await h.coordinator.prepareSessionRecovery('project', 'session')
  expect(prepared).toMatchObject({ status: 'prepared', expectedRevision: 0 })

  await h.coordinator.deleteSession('project', 'session')
  await expect(h.coordinator.commitSessionRecovery(prepared!)).rejects.toThrow('deleted')
  expect(await loadSessionMutationAuthority(h.repository, 'project', 'session')).toEqual({
    status: 'missing'
  })
  expect(await h.repository.loadSessionSummaries()).toEqual([])
})

it('respects an export reservation acquired after recovery preparation', async () => {
  const h = await harness()
  const prepared = await h.coordinator.prepareSessionRecovery('project', 'session')
  const release = await h.coordinator.reserveSessionExport('project', 'session')
  try {
    await expect(h.coordinator.commitSessionRecovery(prepared!)).rejects.toThrow('export')
    expect(await loadSessionMutationAuthority(h.repository, 'project', 'session')).toMatchObject({
      status: 'found',
      session: { revision: h.initial.revision, status: 'running' }
    })
  } finally {
    release()
  }
})

it('preserves a runtime attached after preparation even when its durable revision is unchanged', async () => {
  let live = false
  const h = await harness({ hasLiveRuntimeSession: () => live })
  const prepared = await h.coordinator.prepareSessionRecovery('project', 'session')
  expect(prepared).toMatchObject({ status: 'prepared', session: { status: 'error' } })
  live = true
  await expect(h.coordinator.commitSessionRecovery(prepared!)).resolves.toMatchObject({
    revision: h.initial.revision,
    status: 'running',
    activeRun: { promptMessageId: 'prompt' }
  })
  expect(await loadSessionMutationAuthority(h.repository, 'project', 'session')).toMatchObject({
    status: 'found',
    session: {
      revision: h.initial.revision,
      status: 'running',
      activeRun: { promptMessageId: 'prompt' }
    }
  })
})

it('reports corrupt recovery authority as a failure rather than a missing Session', async () => {
  const h = await harness()
  await writeFile(join(h.root, 'sessions/project/session.json'), '{invalid')
  await expect(h.coordinator.recoverStartupSession('project', 'session')).rejects.toThrow(
    'unreadable'
  )
  await expect(h.coordinator.recoverStartupSession('project', 'absent')).resolves.toBeUndefined()
})
