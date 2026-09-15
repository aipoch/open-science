import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from '../session-persistence/coordinator'
import { AgentComputeService } from './agent-compute-service'
import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import { createSessionCatalogHydration } from './session-catalog-hydration'
import { SessionEnabledComputeHostsOwner } from './session-enabled-hosts-owner'

const createSession = (id: string): PersistedChatSession => ({
  id,
  projectId: 'project-1',
  title: id,
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  filesRevision: 1,
  enabledComputeHosts: ['ssh:alpha'],
  selectedComputeHosts: ['ssh:alpha'],
  createdAt: 1,
  updatedAt: 1
})

const computeHost: ComputeHost = {
  id: 'ssh:alpha',
  providerId: 'ssh:alpha',
  displayName: 'alpha',
  shape: 'direct_ssh',
  sshAlias: 'alpha',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1
}

describe('production Session catalog hydration wiring', () => {
  it('uses fresh read-only enumeration after Project deletion recovery without rehydrating Compute hosts', async () => {
    const session = createSession('session-1')
    const inspectSessionDetailsStartupSessions = vi.fn(async () => [session])
    const recoverPendingDeletions = vi.fn(async () => undefined)
    const hydrateFromSessionCatalog = vi.fn(async (loadCatalog) => loadCatalog())
    const hydration = createSessionCatalogHydration({
      owner: () => ({ hydrateFromSessionCatalog } as never),
      projectRecovery: { recoverPendingDeletions },
      sessionLoader: {
        loadAll: vi.fn(async () => ({
          sessions: [],
          manifest: { version: 1 as const },
          diagnostics: { isComplete: true, warnings: [] }
        })),
        loadAllReadOnly: vi.fn(),
        inspectSessionDetailsStartupSessions
      }
    })

    await hydration.loadAll()
    recoverPendingDeletions.mockClear()
    hydrateFromSessionCatalog.mockClear()
    await expect(hydration.listSessionDetailsStartupSessions()).resolves.toEqual([session])
    expect(recoverPendingDeletions).toHaveBeenCalledOnce()
    expect(inspectSessionDetailsStartupSessions).toHaveBeenCalledOnce()
    expect(hydrateFromSessionCatalog).not.toHaveBeenCalled()
  })

  it('keeps degraded read-only hydration when Project deletion recovery fails', async () => {
    const session = createSession('session-1')
    const inspectSessionDetailsStartupSessions = vi.fn()
    const loadAllReadOnly = vi.fn(async () => ({
      sessions: [session],
      manifest: { version: 1 as const }
    }))
    const hydrateFromSessionCatalog = vi.fn(async (loadCatalog) => loadCatalog())
    const recoverPendingDeletions = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('recovery unavailable'))
    const hydration = createSessionCatalogHydration({
      owner: () => ({ hydrateFromSessionCatalog } as never),
      projectRecovery: { recoverPendingDeletions },
      sessionLoader: {
        loadAll: vi.fn(async () => ({
          sessions: [],
          manifest: { version: 1 as const },
          diagnostics: { isComplete: true, warnings: [] }
        })),
        loadAllReadOnly,
        inspectSessionDetailsStartupSessions
      }
    })

    await hydration.loadAll()
    hydrateFromSessionCatalog.mockClear()
    await expect(hydration.listSessionDetailsStartupSessions()).resolves.toEqual([session])
    expect(loadAllReadOnly).toHaveBeenCalledOnce()
    expect(hydrateFromSessionCatalog).toHaveBeenCalledOnce()
    expect(inspectSessionDetailsStartupSessions).not.toHaveBeenCalled()
  })

  it('retries full hydration when the primary catalog was incomplete', async () => {
    const session = createSession('session-1')
    const loadAll = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [],
        manifest: { version: 1 as const },
        diagnostics: { isComplete: false, warnings: [] }
      })
      .mockResolvedValueOnce({
        sessions: [session],
        manifest: { version: 1 as const },
        diagnostics: { isComplete: true, warnings: [] }
      })
    const inspectSessionDetailsStartupSessions = vi.fn()
    const hydration = createSessionCatalogHydration({
      owner: () => ({
        hydrateFromSessionCatalog: async (loadCatalog: () => Promise<unknown>) => loadCatalog()
      }) as never,
      projectRecovery: { recoverPendingDeletions: vi.fn(async () => undefined) },
      sessionLoader: {
        loadAll,
        loadAllReadOnly: vi.fn(),
        inspectSessionDetailsStartupSessions
      }
    })

    await expect(hydration.loadAll()).resolves.toMatchObject({
      diagnostics: { isComplete: false }
    })
    await expect(hydration.listSessionDetailsStartupSessions()).resolves.toEqual([session])
    expect(loadAll).toHaveBeenCalledTimes(2)
    expect(inspectSessionDetailsStartupSessions).not.toHaveBeenCalled()
  })

  it('keeps the first Compute operation available to five Sessions created after an old complete snapshot', async () => {
    const durableSessions = new Map<string, PersistedChatSession>()
    const snapshotCaptured = Promise.withResolvers<void>()
    const releaseSnapshot = Promise.withResolvers<void>()
    let firstLoad = true
    const repository: SessionMutationRepository = {
      loadAllWithDiagnostics: vi.fn(async () => {
        const sessions = [...durableSessions.values()].map((session) => structuredClone(session))
        if (firstLoad) {
          firstLoad = false
          snapshotCaptured.resolve()
          await releaseSnapshot.promise
        }
        return {
          result: { sessions, manifest: { version: 1 as const } },
          isComplete: true
        }
      }),
      loadProjectWithDiagnostics: vi.fn(async () => ({ sessions: [], isComplete: true })),
      loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
        sessions: [],
        isComplete: true
      })),
      loadSessionWithDiagnostics: vi.fn(async (_projectId, sessionId) => {
        const session = durableSessions.get(sessionId)
        return session
          ? { status: 'found' as const, session: structuredClone(session) }
          : { status: 'missing' as const }
      }),
      assertSessionIdentityOwnership: vi.fn(async () => undefined),
      saveSession: vi.fn(async (session) => {
        durableSessions.set(session.id, structuredClone(session))
        return session
      }),
      saveCommittedProjectSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      deleteProjectSessions: vi.fn(async () => undefined),
      getProjectSessionDeletionState: vi.fn(async () => 'live' as const),
      markCommittedProjectSessionsPrepared: vi.fn(async () => undefined),
      completeProjectSessionDeletion: vi.fn(async () => undefined),
      listLegacyProjectSessionTombstones: vi.fn(async () => []),
      saveManifest: vi.fn(async () => undefined)
    }
    const fileIndex: SessionFileIndex = {
      syncSession: vi.fn(async () => []),
      softDeleteSession: vi.fn(async () => 'delete-token'),
      restoreSession: vi.fn(async () => undefined),
      softDeleteProject: vi.fn(async () => 'delete-token'),
      reconcileActiveSessions: vi.fn(async () => undefined),
      reconcileProjectSessions: vi.fn(async () => undefined),
      markReconciliationIncomplete: vi.fn()
    }
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
    const registry = new EnabledComputeHostsRegistry()
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async (providerId) => providerId === 'ssh:alpha',
      listHostIds: async () => ['ssh:alpha'],
      sessionAuthority: coordinator,
      withDataRootWrite: (operation) => operation()
    })
    const hydration = createSessionCatalogHydration({
      owner: () => owner,
      projectRecovery: { recoverPendingDeletions: async () => undefined },
      sessionLoader: coordinator
    })
    const compute = new AgentComputeService({ list: async () => [computeHost] } as never, registry)

    const loading = hydration.loadAll()
    await snapshotCaptured.promise
    const creations = Array.from({ length: 5 }, (_, index) => {
      const session = createSession(`session-${index + 1}`)
      return owner.createSession(session, (candidate) => coordinator.saveSession(candidate))
    })
    releaseSnapshot.resolve()

    await Promise.all([loading, ...creations])

    const firstComputeOperations = await Promise.all(
      [...durableSessions.keys()].map((sessionId) => compute.listPreferred(sessionId))
    )
    expect(firstComputeOperations).toEqual(
      Array.from({ length: 5 }, () => [expect.objectContaining({ provider_id: 'ssh:alpha' })])
    )
    expect([...durableSessions.values()]).toHaveLength(5)
  })
})
