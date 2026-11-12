import { reserveAcpSessionStorageCleanup } from '../acp/session-registry'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile, access, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
const diagnostics = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }))
const filesystem = vi.hoisted(() => ({
  beforeRead: undefined as ((path: string) => Promise<void>) | undefined,
  beforeRemove: undefined as ((path: string) => Promise<void>) | undefined
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      await filesystem.beforeRead?.(String(args[0]))
      return actual.readFile(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await filesystem.beforeRemove?.(String(args[0]))
      return actual.rm(...args)
    }
  }
})
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/diagnostics/node')>()
  return {
    ...actual,
    createLogger: (scope: string) => ({ ...actual.createLogger(scope), ...diagnostics })
  }
})

import { initDataRoot } from '../storage-root'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionRepository } from './repository'
import { SessionProjectionRepository } from './projection'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import { composeSessionProjection } from '../composition/session-projection'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { ReviewRepository } from '../reviewer/repository'
import { createResearchFilmLifecycle } from '../research-video/lifecycle'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import {
  planPermissionGrantOwnerReconciliation,
  reconcilePermissionGrantOwners
} from '../permission-grants/reconciliation'
import { SessionCacheOwner } from '../compute/session-cache-owner'
import { HarnessStorageCleanup } from '../harness-acp/storage-cleanup'
import { RuntimeSessionOwner } from './runtime-session-owner'
import {
  initializeManagedWorkspaceOwnership,
  finalizeManagedWorkspaceOwnership,
  planProvisionalManagedWorkspaceReconciliation
} from '../storage/managed-workspace-ownership'

let root: string
let client: PrismaClient

afterEach(async () => {
  filesystem.beforeRemove = undefined
  filesystem.beforeRead = undefined
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  for (const log of Object.values(diagnostics)) log.mockClear()
})

async function createStartupHarness(
  dependencies: ConstructorParameters<typeof SessionRepository>[1] = {},
  syncSession: SessionFileIndex['syncSession'] = async () => [],
  workspace?: ConstructorParameters<typeof SessionPersistenceCoordinator>[11]
): Promise<{
  composed: ReturnType<typeof composeSessionProjection>
  coordinator: SessionPersistenceCoordinator
  repository: SessionRepository
  projection: SessionProjectionRepository
  makeSession: (id: string) => PersistedChatSession
  reads: string[]
  owners: Set<string>
  historical: PersistedChatSession
  fileIndex: SessionFileIndex
}> {
  root = await mkdtemp(join(tmpdir(), 'targeted-session-startup-'))
  initDataRoot(root)
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project', name: 'Research' } })
  const reads: string[] = []
  const projection = new SessionProjectionRepository(async () => client)
  const repository = new SessionRepository(
    root,
    {
      ...dependencies,
      readSessionFile: async (path) => {
        reads.push(path)
        return dependencies.readSessionFile
          ? dependencies.readSessionFile(path)
          : readFile(path, 'utf8')
      }
    },
    projection
  )
  const makeSession = (id: string): PersistedChatSession => ({
    id,
    projectId: 'project',
    title: id,
    status: 'idle',
    cwd: '/workspace',
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        content: `History for ${id}`,
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1
  })
  const historical = await repository.saveSession(makeSession('historical'))
  const selected = await repository.saveSession(makeSession('selected'))
  await repository.saveManifest({ lastSessionId: selected.id })
  const interrupted = await repository.saveSession({
    ...makeSession('interrupted'),
    status: 'running',
    activeRun: { promptMessageId: 'interrupted-message', startedAt: 1 }
  })
  await projection.replaceAll([historical, interrupted, selected])
  const owners = new Set(['historical', 'interrupted'])
  const fileIndex: SessionFileIndex = {
    syncSession,
    softDeleteSession: async () => 'unused',
    restoreSession: async () => undefined,
    softDeleteProject: async () => 'unused',
    reconcileProjectSessions: async () => undefined,
    reconcileActiveSessions: async (sessions) => {
      for (const id of owners) if (!sessions.some((session) => session.id === id)) owners.delete(id)
    },
    markReconciliationIncomplete: () => undefined
  }
  const coordinator = new SessionPersistenceCoordinator(
    repository,
    fileIndex,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workspace
  )
  reads.length = 0
  const composed = composeSessionProjection({
    sessionRepository: repository,
    sessionPersistenceCoordinator: coordinator,
    settingsService: {
      allowNotebookNetworkDomain: async () => undefined,
      allowNotebookNetworkDestination: async () => undefined
    },
    sessionEnabledComputeHostsOwnerRef: {
      current: { reconcileSession: async (session: PersistedChatSession) => session }
    },
    projectDeletionCoordinator: { recoverPendingDeletions: async () => undefined },
    wslSetupSessions: {
      reconcileBoundSessions: async () => undefined,
      projectSessionSummaries: async (sessions: unknown) => sessions
    },
    permissionGrantRegistry: {},
    auxiliaryUsageRecorder: {},
    archiveCoordinator: {}
  } as unknown as Parameters<typeof composeSessionProjection>[0])
  return {
    composed,
    coordinator,
    repository,
    projection,
    makeSession,
    reads,
    owners,
    historical,
    fileIndex
  }
}

it('loads selected context while pending and idle history remain summary-only until deferred work starts', async () => {
  const { composed, reads, owners } = await createStartupHarness()
  const hydrated = await composed.loadStartupSessions()
  expect(diagnostics.debug).toHaveBeenCalledWith(
    'Session summaries loaded',
    expect.objectContaining({
      mode: 'summary',
      sessionCount: 3,
      candidateCount: 1,
      queueWaitMs: expect.any(Number),
      summaryReadMs: expect.any(Number)
    })
  )
  expect(JSON.stringify(diagnostics.debug.mock.calls)).not.toContain('History for historical')
  const catalog = await composed.sessionPersistenceBackend.list!()
  expect(catalog.sessions.map(({ id }) => id).sort()).toEqual([
    'historical',
    'interrupted',
    'selected'
  ])
  expect(reads.some((path) => basename(path) === 'historical.json')).toBe(false)
  expect(owners.has('historical')).toBe(true)
  expect(hydrated.map(({ id }) => id)).toEqual(['selected'])
  expect(reads.some((path) => basename(path) === 'interrupted.json')).toBe(false)
  expect(catalog.sessions.find(({ id }) => id === 'interrupted')?.status).toBe('running')
  const worker = composed.createDeferredRecovery(async () => undefined)
  worker.start()
  await worker.settled()
  expect(diagnostics.debug).toHaveBeenCalledWith(
    'deferred Session recovered',
    expect.objectContaining({
      sessionBytes: expect.any(Number),
      authorityReadMs: expect.any(Number),
      jsonParseMs: expect.any(Number),
      prepareMs: expect.any(Number),
      commitMs: expect.any(Number),
      planningMs: expect.any(Number)
    })
  )
  expect(diagnostics.info).toHaveBeenCalledWith(
    'deferred Session recovery completed',
    expect.objectContaining({
      status: 'complete',
      cleanupEligible: true,
      unresolvedCount: 0,
      exhaustedCount: 0
    })
  )
  expect(
    await composed.sessionPersistenceBackend.loadOne({
      projectId: 'project',
      sessionId: 'historical'
    })
  ).toMatchObject({
    messages: [{ content: 'History for historical' }]
  })
})

it('marks pending metadata and permission recovery while leaving completed history summary-only', async () => {
  const { buildSessionProjection } = await import('./projection')
  const base: PersistedChatSession = {
    id: 's',
    projectId: 'p',
    title: 'Title',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }
  expect(
    buildSessionProjection({ ...base, sessionDetailsGenerationEligible: true }).summary
      .needsStartupRecovery
  ).toBe(true)
  expect(
    buildSessionProjection({
      ...base,
      sessionDetailsGeneration: {
        status: 'queued',
        sourceMessageId: 'm',
        requestId: 'r',
        queuedAt: 1
      }
    }).summary.needsStartupRecovery
  ).toBe(true)
  expect(
    buildSessionProjection({ ...base, status: 'waiting-permission' }).summary.needsStartupRecovery
  ).toBe(true)
  expect(
    buildSessionProjection({
      ...base,
      sessionDetailsSource: 'fallback',
      sessionDetailsGeneration: {
        status: 'failed',
        sourceMessageId: 'm',
        requestId: 'r',
        queuedAt: 1,
        completedAt: 2,
        usageUnavailable: true
      }
    }).summary.needsStartupRecovery
  ).toBe(true)
  expect(
    buildSessionProjection({
      ...base,
      branchSource: { sessionId: 'parent' },
      sessionDetailsGeneration: {
        status: 'succeeded',
        sourceMessageId: 'm',
        requestId: 'r',
        queuedAt: 1,
        startedAt: 1,
        completedAt: 2,
        frameworkId: 'codex',
        model: 'm',
        reasoningEffort: 'medium',
        usageUnavailable: true
      }
    }).summary.needsStartupRecovery
  ).toBe(false)
  expect(buildSessionProjection(base).summary.needsStartupRecovery).toBe(false)
})

it.each(['snapshot', 'commit-read', 'index-effects'] as const)(
  'keeps a same-Project terminal durable during delayed historical %s',
  async (phase) => {
    let release!: () => void
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let delaying = false
    let reads = 0
    const h = await createStartupHarness(
      {
        hasLiveRuntimeSession: (_projectId, sessionId) => sessionId === 'active',
        hasActiveRuntimePrompt: (_projectId, sessionId) => sessionId === 'active',
        readSessionFile: async (path) => {
          if (
            delaying &&
            basename(path) === 'interrupted.json' &&
            ++reads === (phase === 'snapshot' ? 1 : phase === 'commit-read' ? 2 : -1)
          ) {
            enter()
            await blocked
          }
          return readFile(path, 'utf8')
        }
      },
      async (session) => {
        if (delaying && phase === 'index-effects' && session.id === 'interrupted') {
          enter()
          await blocked
        }
        return []
      }
    )
    const active = await h.repository.saveSession(
      materializeSessionConversationGraph({
        ...h.makeSession('active'),
        status: 'running',
        activeRun: { promptMessageId: 'active-message', startedAt: 1 }
      })
    )
    await h.repository.saveManifest({ lastSessionId: 'active' })
    const graph = active.conversationGraph!
    const owner = new RuntimeSessionOwner({
      loadSession: (key) => h.coordinator.loadSessionForContinuation(key.projectId, key.sessionId),
      mutateSession: (key, mutate, committed) =>
        h.coordinator.mutateRuntimeSession(key, mutate, committed),
      finalizeArtifacts: async () => [],
      scheduleFlush: () => () => undefined,
      now: () => 10
    })
    await owner.begin({
      projectId: 'project',
      sessionId: 'active',
      promptMessageId: 'active-message',
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: graph.runtimeSegments[0].id,
      executionId: 'execution'
    })
    const selected = await h.composed.loadStartupSessions()
    expect(selected.map(({ id }) => id)).toEqual(['active'])
    delaying = true
    const workflow = h.composed.createDeferredRecovery(async () => undefined)
    workflow.start()
    await entered
    const historyNavigation = h.composed.sessionPersistenceBackend.loadOne({
      projectId: 'project',
      sessionId: 'interrupted'
    })
    let catalogReady = false
    const catalogDuringRecovery = h.composed.sessionPersistenceBackend.list!().then((result) => {
      catalogReady = true
      return result
    })
    let committed = false
    const terminal = owner.commitTerminal(
      {
        id: 'terminal',
        timestamp: 20,
        sessionId: 'active',
        promptMessageId: 'active-message',
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
      await expect.poll(() => catalogReady, { timeout: 1500 }).toBe(true)
      expect(await h.repository.loadSession('project', 'active')).toMatchObject({ status: 'idle' })
      // Keep the actual read blocked beyond the former terminal admission budget.
      await new Promise((resolve) => setTimeout(resolve, 2600))
    } finally {
      delaying = false
      release()
      await terminal
      await workflow.settled()
      await catalogDuringRecovery
      await historyNavigation
      await workflow.dispose()
      await h.coordinator.readSessionSnapshot('project', 'active')
    }
    expect(await h.repository.loadSession('project', 'interrupted')).toMatchObject({
      status: 'error'
    })
  }
)

it.each(['unreadable', 'oversized', 'index'] as const)(
  'isolates %s history with bounded retries while navigation and healthy recovery remain usable',
  async (failure) => {
    let attempts = 0
    const complete = vi.fn(async () => undefined)
    const h = await createStartupHarness({ maxSessionBytes: 4096 }, async (session) => {
      if (session.id === 'historical' && failure === 'index') {
        attempts += 1
        throw new Error('Index unavailable')
      }
      return []
    })
    if (failure !== 'index')
      await writeFile(
        join(root, 'sessions/project/historical.json'),
        failure === 'oversized' ? 'x'.repeat(8192) : '{invalid'
      )
    const attemptTimes: number[] = []
    const prepare = h.coordinator.prepareSessionRecovery.bind(h.coordinator)
    vi.spyOn(h.coordinator, 'prepareSessionRecovery').mockImplementation((projectId, sessionId) => {
      if (sessionId === 'historical') attemptTimes.push(performance.now())
      return prepare(projectId, sessionId)
    })
    const selected = await h.composed.loadStartupSessions()
    expect(selected.map(({ id }) => id)).toEqual(['selected'])
    expect((await h.composed.sessionPersistenceBackend.list!()).sessions).toHaveLength(3)
    expect(h.reads.some((path) => basename(path) === 'historical.json')).toBe(false)
    const workflow = h.composed.createDeferredRecovery(async () => undefined, complete)
    workflow.start()
    try {
      await expect
        .poll(
          async () =>
            (await h.repository.loadSessionSummaries()).find(({ id }) => id === 'interrupted')
              ?.status
        )
        .toBe('error')
      const active = await h.repository.loadSession('project', 'selected')
      await h.coordinator.saveSession({ ...active!, title: 'Foreground save remains durable' })
      await workflow.settled()
      expect((await h.repository.loadSession('project', 'selected'))?.title).toBe(
        'Foreground save remains durable'
      )
      expect(complete).not.toHaveBeenCalled()
      if (failure === 'index') expect(attempts).toBe(3)
      expect(attemptTimes).toHaveLength(3)
      // Allow timer resolution variance while rejecting immediate retries.
      expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(200)
      expect(attemptTimes[2] - attemptTimes[1]).toBeGreaterThanOrEqual(900)
      const failures = diagnostics.warn.mock.calls
        .filter(
          ([message, fields]) =>
            message === 'deferred Session recovery failed' && fields.sessionId === 'historical'
        )
        .map(([, fields]) => fields)
      expect(failures).toMatchObject([
        { projectId: 'project', phase: 'commit', attempt: 1, retry: true, retryDelayMs: 250 },
        { projectId: 'project', phase: 'commit', attempt: 2, retry: true, retryDelayMs: 1000 },
        { projectId: 'project', phase: 'commit', attempt: 3, retry: false, exhausted: true }
      ])
      expect(diagnostics.info).toHaveBeenCalledWith(
        'deferred Session recovery completed',
        expect.objectContaining({
          status: 'partial',
          sessionCount: 3,
          recoveredCount: 2,
          exhaustedCount: 1,
          unresolvedCount: 1,
          cleanupEligible: false,
          cleanupSkippedReason: 'retries-exhausted'
        })
      )
      expect(JSON.stringify(failures)).not.toContain('History for historical')
      expect(JSON.stringify(failures)).not.toContain(root)
      expect(h.owners.has('historical')).toBe(true)
      expect(h.coordinator.listRuntimeTerminalFailures()).toEqual([])
    } finally {
      await workflow.dispose()
      await workflow.settled()
    }
  }
)

it('retries a background revision conflict and preserves the foreground save while healthy history recovers', async () => {
  const h = await createStartupHarness()
  await h.composed.loadStartupSessions()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let delayed = false
  const prepare = h.coordinator.prepareSessionRecovery.bind(h.coordinator)
  const preparations = vi
    .spyOn(h.coordinator, 'prepareSessionRecovery')
    .mockImplementation(async (projectId, sessionId) => {
      const prepared = await prepare(projectId, sessionId)
      if (sessionId === 'interrupted' && !delayed) {
        delayed = true
        enter()
        await blocked
      }
      return prepared
    })
  const recovered: PersistedChatSession[] = []
  const complete = vi.fn(async () => undefined)
  const workflow = h.composed.createDeferredRecovery(async (session) => {
    recovered.push(session)
  }, complete)
  workflow.start()
  try {
    await entered
    const current = await h.repository.loadSession('project', 'interrupted')
    const newer = await h.coordinator.saveSession({
      ...current!,
      title: 'Foreground revision',
      messages: [
        ...current!.messages,
        { ...h.makeSession('new').messages[0], id: 'new-message', content: 'Foreground message' }
      ],
      updatedAt: 2
    })
    release()
    await workflow.settled()
    expect(
      preparations.mock.calls.filter(([, sessionId]) => sessionId === 'interrupted')
    ).toHaveLength(2)
    expect(diagnostics.warn).toHaveBeenCalledWith(
      'deferred Session recovery failed',
      expect.objectContaining({
        projectId: 'project',
        sessionId: 'interrupted',
        phase: 'commit',
        attempt: 1,
        retry: true,
        retryDelayMs: 250
      })
    )
    expect(recovered.map(({ id }) => id).sort()).toEqual(['historical', 'interrupted', 'selected'])
    expect(complete).toHaveBeenCalledOnce()
    const reopened = await new SessionRepository(root).loadSession('project', 'interrupted')
    expect(reopened).toMatchObject({ revision: newer.revision, title: 'Foreground revision' })
    expect(reopened?.messages.map(({ content }) => content)).toEqual([
      'History for interrupted',
      'Foreground message'
    ])
    expect(h.coordinator.listRuntimeTerminalFailures()).toEqual([])
  } finally {
    release()
    await workflow.dispose()
    await workflow.settled()
  }
})

it('cancels a deferred snapshot without admitting repair after shutdown', async () => {
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let delaying = false
  const repaired: string[] = []
  const h = await createStartupHarness(
    {
      readSessionFile: async (path) => {
        if (delaying && basename(path) === 'interrupted.json') {
          enter()
          await blocked
        }
        return readFile(path, 'utf8')
      }
    },
    async (session) => {
      repaired.push(session.id)
      return []
    }
  )
  await h.composed.loadStartupSessions()
  delaying = true
  const workflow = h.composed.createDeferredRecovery(async () => undefined)
  workflow.start()
  await entered
  try {
    await workflow.dispose()
  } finally {
    delaying = false
    release()
    await workflow.settled()
  }
  expect(repaired).toEqual([])
  expect(
    (await h.repository.loadSessionSummaries()).find(({ id }) => id === 'interrupted')?.status
  ).toBe('running')
})

it('rejects cleanup queued behind a second-repository package publication before adoption', async () => {
  const h = await createStartupHarness()
  const snapshot = await h.repository.scanSessionIdentities()
  const generation = h.coordinator.recoveryCatalogGeneration()
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const publication = h.coordinator.runSessionMutation('project', 'published', async () => {
    await new SessionRepository(root).saveSession(h.makeSession('published'))
    enter()
    await blocked
  })
  await entered
  const apply = vi.fn(async () => undefined)
  const cleanup = h.coordinator.reconcileRecoveryCatalog([], generation, async (operation) => {
    await apply()
    return h.repository.runWithSessionCatalogSnapshot(snapshot, operation)
  })
  release()
  await publication
  expect(await cleanup).toBe(false)
  expect(apply).not.toHaveBeenCalled()
  expect(await h.repository.loadSession('project', 'published')).toBeDefined()
})

it.each([false, true])(
  'preserves shared cwd references and defers cleanup when an earlier reference changes: %s',
  async (changeReference) => {
    const h = await createStartupHarness({}, undefined, {
      planProvisional: (sessions) =>
        planProvisionalManagedWorkspaceReconciliation(sessions, 20, root),
      reconcileProvisional: async () => undefined,
      markProjectRetained: async () => [],
      restoreProjectActive: async () => undefined,
      markRetained: async () => false,
      restoreActive: async () => undefined
    })
    const shared = join(root, 'workspaces', 'shared')
    const orphan = join(root, 'workspaces', 'orphan')
    for (const cwd of [shared, orphan]) {
      await mkdir(cwd, { recursive: true })
      await initializeManagedWorkspaceOwnership(cwd, 'project', 1, root)
      await finalizeManagedWorkspaceOwnership(cwd, 'old-source', 2, root)
    }
    if (!changeReference) {
      const branch = await h.repository.loadSession('project', 'historical')
      await h.repository.saveSession({ ...branch!, cwd: shared }, branch!.revision)
    }
    await h.composed.loadStartupSessions()
    let recovered = 0
    const workflow = h.composed.createDeferredRecovery(async () => {
      recovered += 1
      if (changeReference && recovered === 3) {
        const latest = await h.repository.loadSession('project', 'historical')
        await h.coordinator.saveSession({ ...latest!, cwd: shared, archivedAt: 50 })
      }
    })
    workflow.start()
    try {
      await workflow.settled()
      await expect(access(shared)).resolves.toBeUndefined()
      if (changeReference) {
        await expect(access(orphan)).resolves.toBeUndefined()
        expect(diagnostics.info).toHaveBeenCalledWith(
          'deferred Session catalog cleanup skipped',
          expect.objectContaining({ mode: 'background', reason: 'stale-references' })
        )
      } else await expect(access(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await workflow.dispose()
    }
  }
)

it('refreshes only confirmed missing summaries and preserves authority published before recheck', async () => {
  const { repository, projection, historical } = await createStartupHarness()
  const authority = join(root, 'sessions', historical.projectId, `${historical.id}.json`)
  await rm(authority)
  expect(await repository.loadSessionWithDiagnostics(historical.projectId, historical.id)).toEqual({
    status: 'missing'
  })
  await repository.saveSession(historical)
  expect(
    await repository.reconcileMissingSessionProjection(historical.projectId, historical.id)
  ).toBe(false)
  expect((await projection.list()).some(({ id }) => id === historical.id)).toBe(true)
  await writeFile(authority, '{invalid')
  expect(
    await repository.reconcileMissingSessionProjection(historical.projectId, historical.id)
  ).toBe(false)
  expect((await projection.list()).some(({ id }) => id === historical.id)).toBe(true)
})

it('yields a busy Artifact writer before catalog locking while same-Project terminal saves remain durable', async () => {
  const h = await createStartupHarness({
    hasLiveRuntimeSession: (_projectId, sessionId) => sessionId === 'active',
    hasActiveRuntimePrompt: (_projectId, sessionId) => sessionId === 'active'
  })
  const directory = join(root, 'artifacts/project/historical/.provenance/.staging/versions/orphan')
  await mkdir(directory, { recursive: true })
  const old = new Date(Date.now() - 7200000)
  await utimes(directory, old, old)
  const cutoff = (await stat(directory)).ctimeMs + 1
  const artifacts = new ArtifactProvenanceRepository({
    storageRoot: root,
    getClient: async () => client,
    now: () => new Date(cutoff + 7200000)
  })
  const coordinator = new SessionPersistenceCoordinator(
    h.repository,
    h.fileIndex,
    undefined,
    undefined,
    undefined,
    artifacts
  )
  const prepared = await coordinator.prepareSessionRecovery('project', 'historical')
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writer = artifacts.withSessionMutation(
    { projectId: 'project', appSessionId: 'historical' },
    async () => {
      entered()
      await gate
    }
  )
  await enteredPromise
  const guard = vi.fn(async (apply: () => Promise<void>) => {
    await apply()
    return true
  })
  const cleanup = coordinator.cleanupRecoveredSession(
    prepared!,
    coordinator.recoveryCatalogGeneration(),
    guard,
    cutoff,
    () => false
  )
  try {
    await expect(
      Promise.race([cleanup, new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))])
    ).resolves.toBe('busy')
    expect(guard).not.toHaveBeenCalled()
    const active = await h.repository.saveSession(
      materializeSessionConversationGraph({
        ...h.makeSession('active'),
        status: 'running',
        activeRun: { promptMessageId: 'active-message', startedAt: 1 }
      })
    )
    const graph = active.conversationGraph!
    const owner = new RuntimeSessionOwner({
      loadSession: (key) => coordinator.loadSessionForContinuation(key.projectId, key.sessionId),
      mutateSession: (key, mutate, committed) =>
        coordinator.mutateRuntimeSession(key, mutate, committed),
      finalizeArtifacts: async () => [],
      scheduleFlush: () => () => undefined,
      now: () => 10
    })
    await owner.begin({
      projectId: 'project',
      sessionId: 'active',
      promptMessageId: 'active-message',
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: graph.runtimeSegments[0].id,
      executionId: 'execution'
    })
    await owner.commitTerminal(
      {
        id: 'terminal',
        timestamp: 20,
        sessionId: 'active',
        promptMessageId: 'active-message',
        promptExecutionId: 'execution',
        kind: 'stop',
        level: 'info',
        text: 'end_turn'
      },
      () => undefined
    )
    expect(await new SessionRepository(root).loadSession('project', 'active')).toMatchObject({
      status: 'idle'
    })
  } finally {
    release()
    await writer
    await cleanup
  }
  await coordinator.readSessionSnapshot('project', 'active')
  await expect(
    coordinator.cleanupRecoveredSession(
      prepared!,
      coordinator.recoveryCatalogGeneration(),
      guard,
      cutoff,
      () => false
    )
  ).resolves.toBe('complete')
  await expect(access(directory)).rejects.toThrow()
})

it.each(['workspace', 'artifact'] as const)(
  'keeps terminal saves durable while detached %s removal is slow and retries detached bytes after failure',
  async (kind) => {
    const h = await createStartupHarness(
      {
        hasLiveRuntimeSession: (_p, id) => id === 'active',
        hasActiveRuntimePrompt: (_p, id) => id === 'active'
      },
      undefined,
      {
        planProvisional: (sessions) =>
          planProvisionalManagedWorkspaceReconciliation(sessions, 20, root),
        reconcileProvisional: async () => undefined,
        markProjectRetained: async () => [],
        restoreProjectActive: async () => undefined,
        markRetained: async () => false,
        restoreActive: async () => undefined
      }
    )
    const directory =
      kind === 'workspace'
        ? join(root, 'workspaces/orphan')
        : join(root, 'artifacts/project/historical/.provenance/.staging/versions/orphan')
    await mkdir(directory, { recursive: true })
    if (kind === 'workspace')
      await initializeManagedWorkspaceOwnership(directory, 'project', 1, root)
    const old = new Date(Date.now() - 7200000)
    await utimes(directory, old, old)
    const cutoff = (await stat(directory)).ctimeMs + 1
    const artifacts = new ArtifactProvenanceRepository({
      storageRoot: root,
      getClient: async () => client,
      now: () => new Date(cutoff + 7200000)
    })
    const coordinator =
      kind === 'workspace'
        ? h.coordinator
        : new SessionPersistenceCoordinator(
            h.repository,
            h.fileIndex,
            undefined,
            undefined,
            undefined,
            artifacts
          )
    const active = await h.repository.saveSession(
      materializeSessionConversationGraph({
        ...h.makeSession('active'),
        status: 'running',
        activeRun: { promptMessageId: 'active-message', startedAt: 1 }
      })
    )
    const graph = active.conversationGraph!
    const owner = new RuntimeSessionOwner({
      loadSession: (key) => coordinator.loadSessionForContinuation(key.projectId, key.sessionId),
      mutateSession: (key, mutate, committed) =>
        coordinator.mutateRuntimeSession(key, mutate, committed),
      finalizeArtifacts: async () => [],
      scheduleFlush: () => () => undefined,
      now: () => 10
    })
    await owner.begin({
      projectId: 'project',
      sessionId: 'active',
      promptMessageId: 'active-message',
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: graph.runtimeSegments[0].id,
      executionId: 'execution'
    })
    const snapshot = await h.repository.scanSessionIdentities()
    const guard = (apply: () => Promise<void>): Promise<boolean> =>
      h.repository.runWithSessionCatalogSnapshot(snapshot, apply)
    let release!: () => void
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const retiredPaths: string[] = []
    filesystem.beforeRemove = async (path) => {
      if (path.includes('.retired-')) {
        retiredPaths.push(path)
        enter()
        await gate
        throw new Error('physical delete interrupted')
      }
    }
    const prepared = await coordinator.prepareSessionRecovery('project', 'historical')
    const cleanup =
      kind === 'workspace'
        ? coordinator.reconcileRecoveryCatalog(
            [active, h.historical],
            coordinator.recoveryCatalogGeneration(),
            guard
          )
        : coordinator.cleanupRecoveredSession(
            prepared!,
            coordinator.recoveryCatalogGeneration(),
            guard,
            cutoff,
            () => false
          )
    const cleanupFailed = expect(cleanup).rejects.toThrow()
    await entered
    try {
      await expect(access(directory)).rejects.toThrow()
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'new-live-content'), 'preserve')
      let opened = false
      const navigationSave = coordinator
        .saveSession({ ...h.historical, title: 'Opened during detached cleanup' })
        .then(() => {
          opened = true
        })
      await expect.poll(() => opened, { timeout: 1500 }).toBe(true)
      await navigationSave
      let acknowledged = false
      const terminal = owner.commitTerminal(
        {
          id: 'terminal',
          timestamp: 20,
          sessionId: 'active',
          promptMessageId: 'active-message',
          promptExecutionId: 'execution',
          kind: 'stop',
          level: 'info',
          text: 'end_turn'
        },
        () => {
          acknowledged = true
        }
      )
      await expect.poll(() => acknowledged, { timeout: 1500 }).toBe(true)
      await terminal
      expect(await new SessionRepository(root).loadSession('project', 'active')).toMatchObject({
        status: 'idle'
      })
    } finally {
      release()
      await cleanupFailed
      filesystem.beforeRemove = undefined
    }
    // A new planner rediscovers the private retired namespace without touching a recreated path.
    if (kind === 'workspace') {
      for (const apply of await planProvisionalManagedWorkspaceReconciliation(
        [active, h.historical],
        20,
        root
      )) {
        const remove = await apply()
        await remove?.()
      }
    } else {
      const reopened = new ArtifactProvenanceRepository({
        storageRoot: root,
        getClient: async () => client
      })
      for (const apply of await reopened.planOrphanStagingCleanup(
        'project',
        'historical',
        cutoff
      )) {
        await apply(async (commit) => {
          await commit()
          return true
        })
      }
    }
    expect(await readFile(join(directory, 'new-live-content'), 'utf8')).toBe('preserve')
    expect(retiredPaths.length).toBeGreaterThan(0)
    for (const retiredPath of retiredPaths) await expect(access(retiredPath)).rejects.toThrow()
  }
)

it('keeps newly durable metadata when a ready-list replacement captured an older generation', async () => {
  const h = await createStartupHarness()
  const generation = h.coordinator.recoveryCatalogGeneration()
  const oldSummaries = await h.repository.loadSessionSummaries()
  await h.coordinator.saveSession(h.makeSession('new-session'))
  await h.coordinator.replaceSessionMetadata(oldSummaries, true, generation)
  const metadata = await h.coordinator.sessionMetadataSnapshot()
  expect(metadata.sessions.some(({ id }) => id === 'new-session')).toBe(true)
})

it.each(['review', 'film', 'harness', 'cache', 'permission'] as const)(
  'keeps same-Project terminal durable during native %s repair and cleanup',
  async (kind) => {
    const h = await createStartupHarness({
      hasLiveRuntimeSession: (_p, id) => id === 'active',
      hasActiveRuntimePrompt: (_p, id) => id === 'active'
    })
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot: root,
      getClient: async () => client
    })
    let coordinator = new SessionPersistenceCoordinator(
      h.repository,
      h.fileIndex,
      undefined,
      snapshots
    )
    let blockedPath = ''
    let startPermission: (() => Promise<unknown>) | undefined
    if (kind === 'review') {
      const reviews = new ReviewRepository(async () => client, { snapshotStorageRoot: root })
      const review = await reviews.createReview({
        projectId: 'project',
        sessionId: 'gone',
        turnMessageId: 'prompt',
        scope: { turnMessageId: 'prompt', blocks: [], artifactVersionIds: [] },
        scopeSnapshot: []
      })
      const snapshot = await client.reviewScopeSnapshot.findUniqueOrThrow({
        where: { reviewId: review.id }
      })
      await client.fileOriginSession.create({
        data: { projectId: 'project', sessionId: 'gone', state: 'deleted', deletedAt: new Date() }
      })
      blockedPath = join(root, snapshot.storageKey)
      await rm(blockedPath)
      await client.reviewScopeSnapshot.update({
        where: { id: snapshot.id },
        data: { state: 'staging' }
      })
    } else if (kind === 'film') {
      const key = createHash('sha256')
        .update(JSON.stringify(['project', 'gone', null]))
        .digest('hex')
      blockedPath = join(
        root,
        'research-video-presentations',
        key,
        'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
      )
      await mkdir(blockedPath, { recursive: true })
      await writeFile(
        join(blockedPath, 'session.json'),
        JSON.stringify({ provenance: { projectId: 'project', sessionId: 'gone' } })
      )
      await new Promise((resolve) => setTimeout(resolve, 2))
      const film = createResearchFilmLifecycle({ dataRoot: () => root })
      coordinator.setSessionDeletionHandlers({
        commit: async () => {},
        reconcile: async () => {},
        planReconciliation: (ids) => film.planSessionReconciliation(ids)
      })
    } else if (kind === 'permission') {
      let registry = await createPermissionGrantRegistry({ getClient: async () => client })
      await registry.remember({
        capability: { kind: 'execution', key: 'exec:agent/shell' },
        scope: { kind: 'session', projectId: 'project', sessionId: 'gone' }
      })
      registry = await createPermissionGrantRegistry({
        getClient: async () => client,
        isScopeLive: async (scope) =>
          scope.kind !== 'session' ||
          (await h.repository.loadSession(scope.projectId, scope.sessionId)) !== undefined
      })
      startPermission = () =>
        registry.remember({
          capability: { kind: 'execution', key: 'exec:agent/shell' },
          scope: { kind: 'session', projectId: 'project', sessionId: 'historical' }
        })
      blockedPath = join(root, 'sessions/project/historical.json')
      coordinator = new SessionPersistenceCoordinator(
        h.repository,
        h.fileIndex,
        undefined,
        snapshots,
        undefined,
        undefined,
        {
          reconcileSessions: (sessions) => reconcilePermissionGrantOwners(registry, { sessions }),
          planReconciliation: async (sessions) =>
            (await planPermissionGrantOwnerReconciliation(registry, { sessions })).flatMap(
              ({ owner, apply }) =>
                owner.kind === 'session'
                  ? [{ projectId: owner.projectId, sessionId: owner.sessionId, apply }]
                  : []
            )
        }
      )
    } else if (kind === 'cache') {
      const prior = new SessionCacheOwner(root)
      const operation = await prior.createOperationFile('project', 'gone', 'output')
      await writeFile(operation.path, 'old cache')
      operation.release()
      await new Promise((resolve) => setTimeout(resolve, 2))
      const cache = new SessionCacheOwner(root)
      blockedPath = join(root, 'compute/session-cache/project/gone')
      coordinator = new SessionPersistenceCoordinator(
        h.repository,
        h.fileIndex,
        undefined,
        snapshots,
        undefined,
        undefined,
        {
          reconcileSessions: async () => {},
          planReconciliation: (sessions) => cache.planSessionReconciliation(sessions)
        }
      )
    } else {
      const sessionDirectory = join(root, 'harness-sessions')
      await mkdir(sessionDirectory)
      blockedPath = join(sessionDirectory, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json')
      await writeFile(
        blockedPath,
        JSON.stringify({ owner: { projectId: 'project', sessionId: 'gone' }, cwd: root })
      )
      await new Promise((resolve) => setTimeout(resolve, 2))
      const harness = new HarnessStorageCleanup({
        sessionDirectory,
        receiptDirectory: () => join(root, 'harness-receipts'),
        tryClaimIdentities: reserveAcpSessionStorageCleanup,
        isLive: () => false
      })
      coordinator.setSessionDeletionHandlers({
        commit: async () => {},
        reconcile: async () => {},
        planReconciliation: (ids) => harness.planReconciliation(ids)
      })
    }
    const active = await h.repository.saveSession(
      materializeSessionConversationGraph({
        ...h.makeSession('active'),
        status: 'running',
        activeRun: { promptMessageId: 'active-message', startedAt: 1 }
      })
    )
    const graph = active.conversationGraph!
    const owner = new RuntimeSessionOwner({
      loadSession: (key) => coordinator.loadSessionForContinuation(key.projectId, key.sessionId),
      mutateSession: (key, mutate, committed) =>
        coordinator.mutateRuntimeSession(key, mutate, committed),
      finalizeArtifacts: async () => [],
      scheduleFlush: () => () => undefined,
      now: () => 10
    })
    await owner.begin({
      projectId: 'project',
      sessionId: 'active',
      promptMessageId: 'active-message',
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: graph.runtimeSegments[0].id,
      executionId: 'execution'
    })
    let release!: () => void
    let entered = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const intercept = async (path: string): Promise<void> => {
      if (path === blockedPath) {
        entered = true
        await gate
      }
    }
    if (kind === 'review' || kind === 'permission') filesystem.beforeRead = intercept
    else filesystem.beforeRemove = intercept
    const permissionMutation = startPermission?.()
    const catalog = await h.repository.scanSessionIdentities()
    const cleanup = coordinator.reconcileRecoveryCatalog(
      [active, h.historical],
      coordinator.recoveryCatalogGeneration(),
      (apply) => h.repository.runWithSessionCatalogSnapshot(catalog, apply)
    )
    try {
      await expect.poll(() => entered, { timeout: 1500 }).toBe(true)
      let acknowledged = false
      const terminal = owner.commitTerminal(
        {
          id: 'terminal',
          timestamp: 20,
          sessionId: 'active',
          promptMessageId: 'active-message',
          promptExecutionId: 'execution',
          kind: 'stop',
          level: 'info',
          text: 'end_turn'
        },
        () => {
          acknowledged = true
        }
      )
      await expect.poll(() => acknowledged, { timeout: 1500 }).toBe(true)
      await terminal
      expect(await new SessionRepository(root).loadSession('project', 'active')).toMatchObject({
        status: 'idle'
      })
    } finally {
      release()
      await cleanup
      await permissionMutation
      filesystem.beforeRead = undefined
      filesystem.beforeRemove = undefined
    }
    if (kind === 'review') {
      expect(await readFile(blockedPath, 'utf8')).toContain('gone')
      expect(
        await client.reviewScopeSnapshot.count({ where: { state: 'ready', sessionId: 'gone' } })
      ).toBe(1)
    } else if (kind !== 'permission') await expect(access(blockedPath)).rejects.toThrow()
    else expect(await client.permissionGrant.count({ where: { sessionId: 'gone' } })).toBe(0)
  }
)
