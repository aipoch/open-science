import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadAllSessionsResult, PersistedChatSession } from '../../shared/session-persistence'
import { composeSessionProjection } from './session-projection'

vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers: vi.fn() }))
vi.mock('../compute/session-catalog-hydration', () => ({
  createSessionCatalogHydration: ({
    sessionLoader
  }: {
    sessionLoader: { loadAll(): Promise<LoadAllSessionsResult> }
  }) => ({
    loadAll: () => sessionLoader.loadAll()
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
  const allowDomain = vi.fn(
    async (_host: string, assertCurrent?: () => Promise<void>, finalize?: () => Promise<void>) => {
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
    settingsService: { allowNotebookNetworkDomain: allowDomain },
    sessionPersistenceCoordinator: coordinator,
    sessionRepository: { loadSession: async () => structuredClone(session) },
    sessionEnabledComputeHostsOwnerRef: {},
    projectDeletionCoordinator: {},
    permissionGrantRegistry: {},
    wslSetupSessions: {},
    auxiliaryUsageRecorder: {},
    archiveCoordinator: {}
  } as unknown as Parameters<typeof composeSessionProjection>[0])
  return { ...composed, session, allowDomain, coordinator }
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
      expect(f.allowDomain).toHaveBeenCalledTimes(1)
      await f.loadAllSessions()
      expect(f.allowDomain).toHaveBeenCalledTimes(1)
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
    expect(f.allowDomain).not.toHaveBeenCalled()
    expect(f.coordinator.patchSessionRuntimeContext).not.toHaveBeenCalled()
    expect(f.session.runtimeContext?.networkApprovals).toHaveLength(1)
  })

  it('keeps transcripts and saved consent on recovery failure, then retries the next catalog read', async () => {
    const f = fixture()
    f.allowDomain.mockRejectedValueOnce(new Error('Settings unavailable'))
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
})
