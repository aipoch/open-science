import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  SessionSummary
} from '../../shared/session-persistence'
import { broadcastToRenderers } from '../renderer-broadcast'
import { composeSessionProjection } from './session-projection'

vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers: vi.fn() }))
vi.mock('../compute/session-catalog-hydration', () => ({
  createSessionCatalogHydration: ({
    sessionLoader
  }: {
    sessionLoader: { loadAll(): Promise<LoadAllSessionsResult> }
  }) => ({
    loadAll: () => sessionLoader.loadAll(),
    recoverProjectDeletions: async () => ({ isComplete: true })
  })
}))
const recovery = vi.hoisted(() => ({ complete: true }))
vi.mock('../session-persistence/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session-persistence/ipc')>()),
  recoverProjectDeletionsForSessionRead: async (
    _: unknown,
    loader: { loadAll(): Promise<LoadAllSessionsResult> }
  ) => ({
    isComplete: recovery.complete,
    result: await loader.loadAll()
  })
}))
afterEach(() => {
  recovery.complete = true
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

const fixture = (() => {
  const session: PersistedChatSession = {
    id: 'session-fixture',
    projectId: 'project-fixture',
    title: 'Saved decision',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    runtimeContext: {
      version: 1,
      revision: 1,
      networkApprovals: [
        {
          version: 1,
          kind: 'sandbox-network',
          state: 'continuing',
          decision: 'always-allow',
          requestId: 'request-fixture',
          sessionId: 'session-fixture',
          executionId: 'run-fixture',
          commandFingerprint: 'a'.repeat(64),
          hostname: 'service.example.test',
          protocol: 'http',
          port: 443,
          runtime: 'bash',
          originatingPromptMessageId: 'prompt-fixture',
          agentFrameId: 'frame-fixture',
          messageBranchId: 'branch-fixture',
          createdAt: 1
        }
      ]
    }
  }
  const allowDestination = vi.fn(
    async (
      _grant: import('../../shared/network-destination-grants').NetworkDestinationGrant,
      assertCurrent?: () => Promise<void>,
      finalize?: () => Promise<void>
    ) => {
      await assertCurrent?.()
      await finalize?.()
    }
  )
  const coordinator = {
    loadAll: async (): Promise<LoadAllSessionsResult> => ({
      sessions: [structuredClone(session)],
      manifest: { version: 1 },
      diagnostics: {
        isComplete: recovery.complete,
        warnings: [],
        isProjectDeletionRecoveryComplete: recovery.complete
      }
    }),
    readSessionRuntimeContext: async () => structuredClone(session.runtimeContext!),
    loadSessionForContinuation: async () => structuredClone(session),
    patchSessionRuntimeContext: vi.fn(
      async (command: { expectedRevision: number; patch: object }) => {
        expect(command.expectedRevision).toBe(session.runtimeContext!.revision)
        session.runtimeContext = {
          ...session.runtimeContext!,
          ...command.patch,
          revision: command.expectedRevision + 1
        }
        return session.runtimeContext
      }
    ),
    projectRuntimeSession: (value: PersistedChatSession) => value,
    recordSessionRecordProblem: vi.fn()
  }
  const composed = composeSessionProjection({
    settingsService: {
      allowNotebookNetworkDomain: vi.fn(),
      allowNotebookNetworkDestination: allowDestination
    },
    sessionPersistenceCoordinator: coordinator,
    sessionRepository: { loadSession: async () => structuredClone(session) },
    sessionEnabledComputeHostsOwnerRef: {},
    projectDeletionCoordinator: {},
    permissionGrantRegistry: {},
    wslSetupSessions: {},
    auxiliaryUsageRecorder: {},
    archiveCoordinator: {}
  } as unknown as Parameters<typeof composeSessionProjection>[0])
  return { ...composed, session, allowDestination, coordinator }
}) satisfies () => ReturnType<typeof composeSessionProjection> & { session: PersistedChatSession }

describe('host network approval recovery', () => {
  it.each(['catalog', 'detail'] as const)(
    'finishes saved consent through %s reads without a provider runtime',
    async (surface) => {
      const f = fixture()
      const loaded =
        surface === 'catalog'
          ? (await f.loadAllSessions()).sessions[0]
          : await f.sessionPersistenceBackend.loadOne({
              projectId: f.session.projectId,
              sessionId: f.session.id
            })
      expect(loaded?.runtimeContext?.networkApprovals).toBeUndefined()
      expect(f.allowDestination).toHaveBeenCalledTimes(1)
      await f.loadAllSessions()
      expect(f.allowDestination).toHaveBeenCalledTimes(1)
    }
  )

  it('does not mutate approval authority while project deletion recovery is incomplete', async () => {
    const f = fixture()
    recovery.complete = false
    await f.loadAllSessions()
    await f.sessionPersistenceBackend.loadOne({
      projectId: f.session.projectId,
      sessionId: f.session.id
    })
    expect(f.allowDestination).not.toHaveBeenCalled()
    expect(f.coordinator.patchSessionRuntimeContext).not.toHaveBeenCalled()
    expect(f.session.runtimeContext?.networkApprovals).toHaveLength(1)
  })

  it('keeps transcripts and saved consent on recovery failure, then retries the next catalog read', async () => {
    const f = fixture()
    f.allowDestination.mockRejectedValueOnce(new Error('Settings unavailable'))
    const failed = await f.loadAllSessions()
    expect(failed.diagnostics).toMatchObject({
      isComplete: false,
      failure: 'startup-reconciliation-failed'
    })
    expect(failed.sessions[0].runtimeContext?.networkApprovals?.[0].decision).toBe('always-allow')
    const recovered = await f.loadAllSessions()
    expect(recovered.diagnostics?.isComplete).toBe(true)
    expect(recovered.sessions[0].runtimeContext?.networkApprovals).toBeUndefined()
  })

  it('serves projection summaries while startup hydration is pending', async () => {
    const summary = {
      id: 'summary-session',
      projectId: 'summary-project',
      number: 1,
      title: 'Summary session',
      status: 'idle',
      presentedStatus: 'idle',
      pinned: false,
      revision: 1,
      activeMessageCount: 0,
      artifactCount: 0,
      filesRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      needsStartupRecovery: false
    } satisfies SessionSummary
    let resolveProjection!: (value: { sessions: SessionSummary[] }) => void
    const projection = new Promise<{ sessions: SessionSummary[] }>((resolve) => {
      resolveProjection = resolve
    })
    const newerSummary = { ...summary, title: 'New summary session', revision: 2 }
    const replaceSessionMetadata = vi.fn()
    const sessionRepository = {
      ensureSessionProjection: vi
        .fn()
        .mockImplementationOnce(() => projection)
        .mockImplementationOnce(async () => ({ sessions: [newerSummary] })),
      listProjectionSummaries: vi.fn(async () => [summary]),
      reconcilePendingSessionProjection: vi.fn(async () => undefined),
      loadManifest: vi.fn(async () => ({ version: 1 })),
      loadSession: vi.fn(async () => undefined)
    }
    const composed = composeSessionProjection({
      settingsService: {
        allowNotebookNetworkDomain: vi.fn(),
        allowNotebookNetworkDestination: vi.fn()
      },
      sessionPersistenceCoordinator: {
        recoveryCatalogGeneration: () => 7,
        replaceSessionMetadata,
        projectRuntimeSessionSummaries: async (sessions: SessionSummary[]) => sessions,
        loadAll: vi.fn()
      },
      sessionRepository,
      sessionEnabledComputeHostsOwnerRef: {},
      projectDeletionCoordinator: {},
      permissionGrantRegistry: {},
      wslSetupSessions: {
        reconcileBoundSessions: vi.fn(async () => undefined),
        projectSessionSummaries: async (sessions: SessionSummary[]) => sessions
      },
      auxiliaryUsageRecorder: {},
      archiveCoordinator: {}
    } as unknown as Parameters<typeof composeSessionProjection>[0])

    const pendingList = composed.sessionPersistenceBackend.list!()
    await vi.waitFor(() => expect(sessionRepository.ensureSessionProjection).toHaveBeenCalledOnce())
    await expect(pendingList).resolves.toMatchObject({
      sessions: [summary],
      diagnostics: { catalogHydrationPending: true }
    })
    expect(sessionRepository.listProjectionSummaries).toHaveBeenCalledOnce()
    expect(replaceSessionMetadata).toHaveBeenCalledWith([summary], false, 7)

    resolveProjection({ sessions: [summary] })
    await vi.waitFor(() => {
      expect(replaceSessionMetadata).toHaveBeenLastCalledWith([summary], true, 7)
      expect(broadcastToRenderers).toHaveBeenCalledWith('sessions:catalog-changed', undefined)
    })

    await expect(composed.sessionPersistenceBackend.list!()).resolves.toMatchObject({
      sessions: [newerSummary]
    })
    expect(sessionRepository.ensureSessionProjection).toHaveBeenCalledTimes(2)
    expect(broadcastToRenderers).toHaveBeenCalledTimes(1)
  })
})
