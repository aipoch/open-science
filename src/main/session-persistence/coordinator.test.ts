import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import {
  materializeSessionConversationGraph,
  type PersistedArtifact,
  type PersistedChatSession,
  type SessionPlanRuntimeContext
} from '../../shared/session-persistence'
import type { ArtifactProjectReconciliationSnapshot } from '../artifacts/provenance-repository'
import { FinalizedArtifactBindingConflictError } from '../artifacts/provenance-message-snapshot'
import type { Logger } from '../logger'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError,
  UploadRepository
} from '../uploads/repository'
import {
  SessionRuntimeContextRevisionConflictError,
  SessionPersistenceCoordinator,
  type SessionDeletionHandlers,
  type SessionFileIndex,
  type SessionMutationRepository,
  type SessionProvenancePersistence
} from './coordinator'

const createSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

const createRuntimePlan = (
  overrides: Partial<SessionPlanRuntimeContext> = {}
): SessionPlanRuntimeContext => ({
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  approval: 'pending',
  stepStatuses: {},
  ...overrides
})

const createLegacyUploadSession = (sessionId: string): PersistedChatSession =>
  createSession({
    id: sessionId,
    messages: [
      {
        id: `${sessionId}-message`,
        role: 'user',
        content: 'legacy upload',
        status: 'complete',
        eventIds: [],
        uploads: [
          {
            id: `${sessionId}-upload`,
            sessionId,
            name: 'legacy.csv',
            originalName: 'legacy.csv',
            path: `/legacy/${sessionId}/legacy.csv`,
            size: 11
          }
        ],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })

const toVersionedUploadSession = (session: PersistedChatSession): PersistedChatSession => {
  const upgraded = structuredClone(session)
  upgraded.messages[0].uploads = [
    {
      id: `${session.id}-upload`,
      versionId: `${session.id}-upload-version`,
      versionNumber: 1,
      sessionId: session.id,
      name: 'legacy.csv',
      originalName: 'legacy.csv',
      size: 11,
      sha256: 'a'.repeat(64)
    }
  ]
  return upgraded
}

const createRecoveredArtifact = (
  overrides: Partial<ArtifactVersionFile> = {}
): ArtifactVersionFile => ({
  id: 'artifact-version-1',
  artifactId: 'artifact-lineage-1',
  versionId: 'artifact-version-1',
  versionNumber: 1,
  checksum: 'a'.repeat(64),
  createdAt: '2026-07-29T00:00:00.000Z',
  projectName: 'project-1',
  sessionId: 'session-1',
  runId: 'artifact-run-1',
  name: 'result.csv',
  path: '/managed/.provenance/artifact-lineage-1/versions/artifact-version-1/content',
  fileUrl: 'file:///managed/result.csv',
  mimeType: 'text/csv',
  size: 12,
  mtimeMs: 3,
  ...overrides
})

const createPersistedRecoveredArtifact = (
  overrides: Partial<ArtifactVersionFile> = {}
): PersistedArtifact => {
  const artifact = createRecoveredArtifact(overrides)
  return {
    id: artifact.id,
    artifactId: artifact.artifactId,
    versionId: artifact.versionId,
    versionNumber: artifact.versionNumber,
    kind: 'managed-file',
    path: artifact.path,
    fileUrl: artifact.fileUrl,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs,
    sha256: artifact.checksum
  }
}

const createLegacyArtifactAlias = (): PersistedArtifact => ({
  id: 'session-1:message-1:result.csv',
  artifactId: 'artifact-lineage-1',
  versionId: 'artifact-version-1',
  versionNumber: 1,
  kind: 'managed-file',
  path: '/managed/message-1/result.csv',
  fileUrl: 'file:///managed/message-1/result.csv',
  name: 'result.csv',
  mimeType: 'text/csv',
  size: 12,
  mtimeMs: 2
})

const createProjectReconciliationSnapshot = (): ArtifactProjectReconciliationSnapshot =>
  ({}) as ArtifactProjectReconciliationSnapshot

describe('SessionPersistenceCoordinator', () => {
  it('persists blocked Plan feedback as a standard user Message without changing Plan authority', async () => {
    let durable = createSession({
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.appendUserMessageToInteraction({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content: 'Split the analysis by cohort.'
    })

    expect(durable.messages).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: 'Split the analysis by cohort.',
        responseToMessageId: 'interaction-1',
        status: 'complete'
      })
    )
    expect(durable.runtimeContext).toEqual({
      version: 1,
      revision: 2,
      plan: createRuntimePlan()
    })
    expect(durable.status).toBe('waiting-plan-approval')
  })

  it('atomically reads and patches main-owned runtime context with a new revision', async () => {
    const previousUpdatedAt = Date.now() + 10_000
    let durable = createSession({ updatedAt: previousUpdatedAt })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(coordinator.readSessionRuntimeContext('project-1', 'session-1')).resolves.toEqual({
      version: 1,
      revision: 0
    })
    await expect(
      coordinator.patchSessionRuntimeContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 0,
        patch: { plan: createRuntimePlan() }
      })
    ).resolves.toEqual({
      version: 1,
      revision: 1,
      plan: createRuntimePlan()
    })
    await expect(coordinator.readSessionRuntimeContext('project-1', 'session-1')).resolves.toEqual({
      version: 1,
      revision: 1,
      plan: createRuntimePlan()
    })
    expect(durable.updatedAt).toBeGreaterThan(previousUpdatedAt)
  })

  it('rejects stale and duplicate runtime context patches without overwriting durable authority', async () => {
    let durable = createSession({
      runtimeContext: { version: 1, revision: 4, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const command = {
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 4,
      patch: { plan: createRuntimePlan({ approval: 'approved' }) }
    } as const

    await expect(coordinator.patchSessionRuntimeContext(command)).resolves.toMatchObject({
      revision: 5,
      plan: createRuntimePlan({ approval: 'approved' })
    })
    await expect(coordinator.patchSessionRuntimeContext(command)).rejects.toMatchObject({
      code: 'revision-conflict',
      expectedRevision: 4,
      actualRevision: 5
    })
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(durable.runtimeContext).toMatchObject({
      revision: 5,
      plan: createRuntimePlan({ approval: 'approved' })
    })
    expect(SessionRuntimeContextRevisionConflictError).toBeTypeOf('function')
  })

  it('preserves authoritative runtime context and approval waiting status on a stale renderer save', async () => {
    const previousUpdatedAt = Date.now() + 10_000
    let durable = createSession({
      title: 'Before rename',
      status: 'waiting-plan-approval',
      updatedAt: previousUpdatedAt,
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const staleRendererSnapshot = createSession({
      title: 'Renamed by renderer',
      status: 'idle',
      runtimeContext: {
        version: 1,
        revision: 0,
        plan: createRuntimePlan({ approval: 'approved' })
      }
    })

    await expect(coordinator.saveSession(staleRendererSnapshot)).resolves.toMatchObject({
      title: 'Renamed by renderer',
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    expect(durable.runtimeContext).toEqual({
      version: 1,
      revision: 2,
      plan: createRuntimePlan()
    })
    expect(durable.updatedAt).toBeGreaterThan(previousUpdatedAt)
  })

  it('does not let a renderer whole-session save create runtime authority', async () => {
    let durable: PersistedChatSession | undefined
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({ status: 'missing' as const })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const result = await coordinator.saveSession(
      createSession({
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 9,
          plan: createRuntimePlan({ approval: 'approved' })
        }
      })
    )

    expect(result.runtimeContext).toBeUndefined()
    expect(result.status).toBe('idle')
    expect(durable?.runtimeContext).toBeUndefined()
  })

  it('commits approval waiting state with context only after the atomic write succeeds', async () => {
    let durable = createSession()
    let failNextSave = true
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        if (failNextSave) {
          failNextSave = false
          throw new Error('partial write rejected')
        }
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const command = {
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 0,
      patch: { plan: createRuntimePlan() },
      sessionStatus: 'waiting-plan-approval'
    } as const

    await expect(coordinator.patchSessionRuntimeContext(command)).rejects.toThrow(
      'partial write rejected'
    )
    expect(durable).toMatchObject({ status: 'idle' })
    expect(durable.runtimeContext).toBeUndefined()

    await expect(coordinator.patchSessionRuntimeContext(command)).resolves.toMatchObject({
      revision: 1,
      plan: createRuntimePlan()
    })
    expect(durable).toMatchObject({
      status: 'waiting-plan-approval',
      runtimeContext: { revision: 1, plan: createRuntimePlan() }
    })
  })

  it('serializes a runtime patch before concurrent Session deletion and never revives it', async () => {
    let durable: PersistedChatSession | undefined = createSession()
    const saveGate = createDeferred<void>()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () =>
        durable ? { status: 'found' as const, session: durable } : { status: 'missing' as const }
      ),
      saveSession: vi.fn(async (session) => {
        await saveGate.promise
        durable = structuredClone(session)
      }),
      deleteSession: vi.fn(async () => {
        durable = undefined
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const patch = coordinator.patchSessionRuntimeContext({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 0,
      patch: { plan: createRuntimePlan() }
    })
    const deletion = coordinator.deleteSession('project-1', 'session-1')
    await vi.waitFor(() => expect(repository.saveSession).toHaveBeenCalledOnce())
    saveGate.resolve()

    await expect(patch).resolves.toMatchObject({ revision: 1 })
    await expect(deletion).resolves.toBeUndefined()
    expect(durable).toBeUndefined()
    await expect(
      coordinator.patchSessionRuntimeContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 1,
        patch: { plan: undefined }
      })
    ).rejects.toThrow(/deleted/)
  })

  it('removes embedded runtime context with Project Session authority', async () => {
    let durable: PersistedChatSession | undefined = createSession({
      runtimeContext: {
        version: 1,
        revision: 7,
        plan: createRuntimePlan({ approval: 'approved' })
      }
    })
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn(async () => ({
        sessions: durable ? [durable] : [],
        isComplete: true
      })),
      loadSessionWithDiagnostics: vi.fn(async () =>
        durable ? { status: 'found' as const, session: durable } : { status: 'missing' as const }
      ),
      deleteProjectSessions: vi.fn(async () => {
        durable = undefined
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(durable).toBeUndefined()
    await expect(
      coordinator.patchSessionRuntimeContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 7,
        patch: { plan: undefined }
      })
    ).rejects.toThrow(/project.*deleted/i)
  })

  it('exposes Session metadata from the latest complete load without reading storage again', async () => {
    const session = createSession({ title: 'Cached session' })
    const loadAllWithDiagnostics = vi.fn().mockResolvedValue({
      result: { sessions: [session], manifest: { version: 1 as const } },
      isComplete: true
    })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({ loadAllWithDiagnostics }),
      createFileIndex()
    )

    await coordinator.loadAll()

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Cached session' }],
      isComplete: true
    })
    expect(loadAllWithDiagnostics).toHaveBeenCalledOnce()
  })

  it('updates cached Session metadata after a durable save', async () => {
    const session = createSession({ title: 'Original title' })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadAllWithDiagnostics: vi.fn().mockResolvedValue({
          result: { sessions: [session], manifest: { version: 1 as const } },
          isComplete: true
        })
      }),
      createFileIndex()
    )

    await coordinator.loadAll()
    await coordinator.saveSession(createSession({ title: 'Renamed session' }))

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Renamed session' }],
      isComplete: true
    })
  })

  it('waits for an in-flight save before returning Session metadata', async () => {
    const saveGate = createDeferred<void>()
    const repository = createSessionRepository({
      saveSession: vi.fn(() => saveGate.promise)
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const save = coordinator.saveSession(createSession({ title: 'Renamed session' }))
    await vi.waitFor(() => expect(repository.saveSession).toHaveBeenCalledOnce())
    const snapshot = Promise.resolve(coordinator.sessionMetadataSnapshot())

    saveGate.resolve()
    await save

    await expect(snapshot).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Renamed session' }],
      isComplete: false
    })
  })

  it('marks saved Session metadata incomplete when the derived file index update fails', async () => {
    const session = createSession({ title: 'Original title' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [session], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const syncSession = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('index unavailable'))
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ syncSession })
    )

    await coordinator.loadAll()
    await expect(
      coordinator.saveSession(createSession({ title: 'Durable renamed session' }))
    ).rejects.toThrow('index unavailable')

    expect(repository.saveSession).toHaveBeenCalled()
    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Durable renamed session' }],
      isComplete: false
    })
  })

  it('removes cached Session metadata after durable deletion', async () => {
    const session = createSession()
    const loadAllWithDiagnostics = vi
      .fn()
      .mockResolvedValueOnce({
        result: { sessions: [session], manifest: { version: 1 as const } },
        isComplete: true
      })
      .mockResolvedValueOnce({
        result: { sessions: [], manifest: { version: 1 as const } },
        isComplete: true
      })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadAllWithDiagnostics,
        loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session })
      }),
      createFileIndex()
    )

    await coordinator.loadAll()
    await coordinator.deleteSession('project-1', 'session-1')

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [],
      isComplete: true
    })
  })

  it('removes only the deleted Project from cached Session metadata', async () => {
    const deletedSession = createSession()
    const survivingSession = createSession({ id: 'session-2', projectId: 'project-2' })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadAllWithDiagnostics: vi.fn().mockResolvedValue({
          result: {
            sessions: [deletedSession, survivingSession],
            manifest: { version: 1 as const }
          },
          isComplete: true
        }),
        loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
          sessions: [deletedSession],
          isComplete: true
        })
      }),
      createFileIndex()
    )

    await coordinator.loadAll()
    await coordinator.deleteProjectSessions('project-1')

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-2', projectId: 'project-2', title: 'Session' }],
      isComplete: true
    })
  })

  it('marks cached Session metadata incomplete until a complete authority scan succeeds', async () => {
    const session = createSession()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadAllWithDiagnostics: vi.fn().mockResolvedValue({
          result: { sessions: [session], manifest: { version: 1 as const } },
          isComplete: false
        })
      }),
      createFileIndex()
    )

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [],
      isComplete: false
    })

    await coordinator.loadAll()

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Session' }],
      isComplete: false
    })
  })

  it('serializes a pending save before deletion and rejects saves after the tombstone', async () => {
    const order: string[] = []
    const saveGate = createDeferred<void>()
    const repository = createSessionRepository({
      saveSession: vi.fn(async () => {
        order.push('json-save:start')
        await saveGate.promise
        order.push('json-save:end')
      }),
      deleteSession: vi.fn(async () => {
        order.push('json-delete')
      })
    })
    const fileIndex = createFileIndex({
      syncSession: vi.fn(async () => {
        order.push('index-sync')
        return ['artifact' as const]
      }),
      softDeleteSession: vi.fn(async () => {
        order.push('index-soft-delete')
        return 'delete-session-operation'
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    const save = coordinator.saveSession(createSession())
    const deletion = coordinator.deleteSession('project-1', 'session-1')
    await flushMicrotasks()
    expect(order).toEqual(['json-save:start'])

    saveGate.resolve()
    await Promise.all([save, deletion])
    expect(order).toEqual([
      'json-save:start',
      'json-save:end',
      'index-sync',
      'index-soft-delete',
      'json-delete'
    ])

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/deleted/)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('returns the exact durable Session after publishing legacy Uploads in live-safe mode', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const durableSession = toVersionedUploadSession(legacySession)
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(durableSession)
    }
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.saveSession(legacySession)).resolves.toBe(durableSession)
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      { mode: 'live-save' }
    )
    expect(repository.saveSession).toHaveBeenCalledWith(durableSession)
  })

  it('does not overwrite Session JSON when finalized Artifact bindings reject the snapshot', async () => {
    let durableSession = createSession({ title: 'Durable latest' })
    const repository = createSessionRepository({
      saveSession: vi.fn(async (session) => {
        durableSession = session
      })
    })
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi
        .fn()
        .mockRejectedValue(
          new FinalizedArtifactBindingConflictError(
            'Artifact-owning Message is outside its bound Branch.'
          )
        )
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance
    )

    await expect(coordinator.saveSession(createSession({ title: 'Queued stale' }))).rejects.toThrow(
      'Artifact-owning Message is outside its bound Branch.'
    )

    expect(durableSession.title).toBe('Durable latest')
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(provenance.captureFinalizedMessages).not.toHaveBeenCalled()
  })

  it('keeps JSON-first durability when pre-save provenance lookup is unavailable', async () => {
    const validationError = new Error('artifact database unavailable at /private/session.json')
    const repository = createSessionRepository()
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi.fn().mockRejectedValue(validationError)
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(
      coordinator.saveSession(createSession({ title: 'Private research' }))
    ).resolves.toMatchObject({
      id: 'session-1'
    })
    await expect(
      coordinator.saveSession(createSession({ title: 'Retry validation' }))
    ).resolves.toMatchObject({ id: 'session-1' })

    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledTimes(2)
    expect(repository.saveSession).toHaveBeenCalledTimes(2)
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith('pre-save provenance validation unavailable', {
      operation: 'session-save',
      phase: 'validate-provenance',
      outcome: 'degraded',
      errorCategory: 'error'
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('artifact database unavailable')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Private research')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('/private/session.json')
  })

  it('keeps JSON-first durability when degraded diagnostics cannot be emitted', async () => {
    const repository = createSessionRepository()
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi.fn().mockRejectedValue(new Error('lookup unavailable'))
    })
    const log = createTestLogger()
    log.warn.mockImplementation(() => {
      throw new Error('diagnostic sink unavailable')
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(coordinator.saveSession(createSession())).resolves.toMatchObject({
      id: 'session-1'
    })

    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledOnce()
  })

  it('revalidates finalized bindings only when topology or artifact bindings change', async () => {
    const provenance = createProvenancePersistence()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex(),
      undefined,
      provenance
    )
    const firstMessage = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'streaming',
      status: 'streaming' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }

    await coordinator.saveSession(createSession({ messages: [firstMessage] }))
    await coordinator.saveSession(
      createSession({
        title: 'Renamed while streaming',
        messages: [{ ...firstMessage, content: 'more text', updatedAt: 2 }]
      })
    )

    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledOnce()

    const secondMessage = {
      id: 'message-2',
      role: 'user' as const,
      content: 'continue',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    await coordinator.saveSession(
      createSession({
        messages: [
          { ...firstMessage, content: 'complete', status: 'complete', updatedAt: 2 },
          secondMessage
        ]
      })
    )

    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledTimes(2)

    await coordinator.runSessionMutation('project-1', 'session-1', async () => undefined)
    await coordinator.saveSession(
      createSession({
        messages: [
          { ...firstMessage, content: 'complete', status: 'complete', updatedAt: 2 },
          { ...secondMessage, content: 'continue after artifact finalization', updatedAt: 4 }
        ]
      })
    )

    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledTimes(3)
  })

  it('rebases explicitly changed safe fields onto the latest durable graph after a conflict', async () => {
    const authoritativeSession = createSession({
      title: 'Durable latest',
      pinned: false,
      messages: [
        {
          id: 'durable-message',
          role: 'agent',
          content: 'Artifact finalized',
          status: 'complete',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      updatedAt: 3
    })
    const submittedSession = createSession({
      title: 'Local rename',
      pinned: true,
      messages: [
        {
          id: 'stale-message',
          role: 'user',
          content: 'Stale graph',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      updatedAt: 4
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: authoritativeSession })
    })
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi
        .fn()
        .mockRejectedValueOnce(
          new FinalizedArtifactBindingConflictError(
            'Artifact-owning Message is outside its bound Branch.'
          )
        )
        .mockResolvedValue(undefined)
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance
    )

    const result = await coordinator.saveSession(submittedSession, {
      conflictRebaseFields: ['title', 'pinned']
    })

    expect(result).toMatchObject({ title: 'Local rename', pinned: true, updatedAt: 5 })
    expect(result.updatedAt).toBeGreaterThan(authoritativeSession.updatedAt)
    expect(result.updatedAt).toBeGreaterThan(submittedSession.updatedAt)
    expect(result.messages).toEqual(authoritativeSession.messages)
    expect(repository.saveSession).toHaveBeenCalledWith(result)
    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledTimes(2)
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledWith(result)
  })

  it('rebases a specialist binding onto the latest durable graph after a conflict', async () => {
    const authoritativeSession = createSession({
      specialistId: 'specialist-old',
      messages: [
        {
          id: 'durable-message',
          role: 'agent',
          content: 'Artifact finalized',
          status: 'complete',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      updatedAt: 3
    })
    const submittedSession = createSession({
      messages: [
        {
          id: 'stale-message',
          role: 'user',
          content: 'Stale graph',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      updatedAt: 4
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: authoritativeSession })
    })
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi
        .fn()
        .mockRejectedValueOnce(new FinalizedArtifactBindingConflictError('stale graph'))
        .mockResolvedValue(undefined)
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance
    )

    const result = await coordinator.saveSessionSpecialistBinding(
      submittedSession,
      'specialist-new'
    )

    expect(result.specialistId).toBe('specialist-new')
    expect(result.messages).toEqual(authoritativeSession.messages)
    expect(repository.saveSession).toHaveBeenCalledWith(result)
  })

  it('restores DB visibility and clears the tombstone when JSON deletion fails', async () => {
    const repository = createSessionRepository({
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('disk locked'))
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')
    expect(fileIndex.softDeleteSession).toHaveBeenCalledWith('project-1', 'session-1')
    expect(fileIndex.restoreSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      'delete-session-operation'
    )

    await expect(coordinator.saveSession(createSession())).resolves.toMatchObject({
      id: 'session-1'
    })
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('retains native Project files and completes the origin tombstone after JSON deletion', async () => {
    const session = createSession({ title: 'Retained analysis' })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session })
    })
    const fileIndex = createFileIndex()
    const onFilesChanged = vi.fn()
    const provenance = {
      validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
      captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
      reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
      prepareSessionDeletion: vi.fn().mockResolvedValue({
        kind: 'retained' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        operationId: 'origin-delete-1'
      }),
      completeSessionDeletion: vi.fn().mockResolvedValue(undefined),
      abortSessionDeletion: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      onFilesChanged,
      provenance
    )

    await coordinator.deleteSession('project-1', 'session-1')

    expect(provenance.prepareSessionDeletion).toHaveBeenCalledWith(session)
    expect(fileIndex.softDeleteSession).not.toHaveBeenCalled()
    expect(repository.deleteSession).toHaveBeenCalledWith('project-1', 'session-1')
    expect(provenance.completeSessionDeletion).toHaveBeenCalledWith({
      kind: 'retained',
      projectId: 'project-1',
      sessionId: 'session-1',
      operationId: 'origin-delete-1'
    })
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      sources: ['artifact', 'upload'],
      kind: 'upsert'
    })
  })

  it('upgrades and persists a legacy upload before deleting its Session', async () => {
    const order: string[] = []
    const legacySession = createSession({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'legacy upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'data.csv',
              originalName: 'data.csv',
              path: '/legacy/data.csv',
              size: 4
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const upgradedSession = structuredClone(legacySession)
    upgradedSession.messages[0].uploads = [
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'data.csv',
        originalName: 'data.csv',
        size: 4,
        sha256: 'a'.repeat(64)
      }
    ]
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: legacySession }),
      saveSession: vi.fn(async () => {
        order.push('save-upgraded')
      }),
      deleteSession: vi.fn(async () => {
        order.push('delete-json')
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (session, options) => {
        if (options?.mode === 'live-save') {
          order.push('upgrade-live')
          return upgradedSession
        }
        order.push('cleanup-terminal')
        expect(session).toBe(upgradedSession)
        return session
      })
    }
    const provenance = {
      validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
      captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
      reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
      prepareSessionDeletion: vi.fn(async () => {
        order.push('prepare-delete')
        return {
          kind: 'ordinary' as const,
          projectId: 'project-1',
          sessionId: 'session-1'
        }
      }),
      completeSessionDeletion: vi.fn().mockResolvedValue(undefined),
      abortSessionDeletion: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance,
      uploads
    )

    await coordinator.deleteSession('project-1', 'session-1')

    expect(order).toEqual([
      'upgrade-live',
      'save-upgraded',
      'cleanup-terminal',
      'prepare-delete',
      'delete-json'
    ])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(1, legacySession, {
      mode: 'live-save'
    })
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(2, upgradedSession, {
      mode: 'terminal-delete'
    })
    expect(provenance.prepareSessionDeletion).toHaveBeenCalledWith(upgradedSession)
  })

  it('retains a legacy Session source when its path-free projection cannot be saved before deletion', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(legacySession)
    let legacySourceRemoved = false
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: legacySession }),
      saveSession: vi.fn().mockRejectedValue(new Error('session file unavailable'))
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (_session, options) => {
        if (options?.mode === 'terminal-delete') legacySourceRemoved = true
        return upgradedSession
      })
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'session file unavailable'
    )

    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledOnce()
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(legacySession, {
      mode: 'live-save'
    })
    expect(legacySourceRemoved).toBe(false)
    expect(fileIndex.softDeleteSession).not.toHaveBeenCalled()
    expect(repository.deleteSession).not.toHaveBeenCalled()
  })

  it('aborts a retained origin tombstone when JSON deletion fails', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session }),
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('disk locked'))
    })
    const fileIndex = createFileIndex()
    const receipt = {
      kind: 'retained' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      operationId: 'origin-delete-1'
    }
    const provenance = {
      validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
      captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
      reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
      prepareSessionDeletion: vi.fn().mockResolvedValue(receipt),
      completeSessionDeletion: vi.fn().mockResolvedValue(undefined),
      abortSessionDeletion: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')

    expect(provenance.abortSessionDeletion).toHaveBeenCalledWith(receipt)
    expect(fileIndex.restoreSession).not.toHaveBeenCalled()
  })

  it('marks the index incomplete when deletion compensation cannot restore DB visibility', async () => {
    const repository = createSessionRepository({
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('disk locked'))
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({
      restoreSession: vi.fn().mockRejectedValueOnce(new Error('database unavailable')),
      markReconciliationIncomplete
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'database unavailable'
    )
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    await expect(coordinator.saveSession(createSession())).resolves.toMatchObject({
      id: 'session-1'
    })
  })

  it('hydrates sessions after indexing and reconciles only a complete scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const fileIndex = createFileIndex()
    const projectReconciliation = createProjectReconciliationSnapshot()
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn().mockResolvedValue(projectReconciliation),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      artifactStorage
    )
    const reconcile = vi.fn(async () => undefined)
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ reconcile }))

    const loaded = await coordinator.loadAll()

    expect(loaded).toBe(result)
    expect(reconcile).toHaveBeenCalledWith(['session-1'])
    expect(artifactStorage.reconcileSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      session,
      {
        removeOrphanStaging: true,
        projectReconciliation
      }
    )
    expect(fileIndex.syncSession).toHaveBeenCalledWith(session)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([session])
  })

  it('records a phased terminal aggregate for complete Session hydration', async () => {
    const session = createSession({ title: 'Private analysis', cwd: '/private/workspace' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)

    expect(log.info.mock.calls.map(([message]) => message)).toEqual([
      'operation started',
      'operation phase',
      'operation phase',
      'operation phase',
      'operation completed'
    ])
    expect(
      log.info.mock.calls
        .map(([, fields]) => (fields as { phase?: string } | undefined)?.phase)
        .filter(Boolean)
    ).toEqual([
      'load-authority',
      'reconcile-unread-deletions',
      'reconcile-derived-state',
      'reconcile-derived-state'
    ])
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'session-hydration',
        operationId: expect.any(String),
        mode: 'reconcile',
        startupCleanupEligible: true,
        phase: 'reconcile-derived-state',
        outcome: 'completed',
        status: 'ready',
        sessionCount: 1,
        warningCount: 0,
        durationMs: expect.any(Number)
      })
    )
    const diagnosticPayload = JSON.stringify(log.info.mock.calls)
    expect(diagnosticPayload).not.toContain('Private analysis')
    expect(diagnosticPayload).not.toContain('/private/workspace')
  })

  it('records a terminal failure when the Session authority scan rejects', async () => {
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi
        .fn()
        .mockRejectedValue(new Error('Session authority unavailable at /private/sessions'))
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(coordinator.loadAll()).rejects.toThrow('Session authority unavailable')

    expect(log.error).toHaveBeenCalledWith(
      'operation failed',
      expect.objectContaining({
        operation: 'session-hydration',
        phase: 'load-authority',
        outcome: 'failed',
        status: 'failed',
        hydrationAvailable: false,
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('Session authority unavailable')
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('/private/sessions')
  })

  it('keeps hydration available and records unread deletion reconciliation degradation', async () => {
    const session = createSession({ title: 'Private analysis' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )
    coordinator.setSessionDeletionHandlers(
      createSessionDeletionHandlers({
        reconcile: vi
          .fn()
          .mockRejectedValue(new Error('unread database unavailable at /private/unread.sqlite'))
      })
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)

    expect(log.warn).toHaveBeenCalledWith('unread deletion reconciliation failed', {
      operation: 'session-hydration',
      phase: 'reconcile-unread-deletions',
      outcome: 'degraded',
      errorCategory: 'error'
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Private analysis')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('unread database unavailable')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('/private/unread.sqlite')
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({ status: 'degraded', degradedReconciliationCount: 1 })
    )
  })

  it('hydrates a read-only snapshot without running startup reconciliation', async () => {
    const session = createSession({ title: 'Private analysis', cwd: '/private/workspace' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result,
        isComplete: true,
        warnings: []
      })
    })
    const fileIndex = createFileIndex()
    const provenance = {
      validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
      captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
      reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
      prepareSessionDeletion: vi.fn(),
      completeSessionDeletion: vi.fn(),
      abortSessionDeletion: vi.fn()
    }
    const uploads = { upgradeLegacySessionUploads: vi.fn() }
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn(),
      reconcileSession: vi.fn()
    }
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance,
      uploads,
      artifactStorage,
      undefined,
      log
    )

    await expect(coordinator.loadAllReadOnly()).resolves.toEqual({
      ...result,
      diagnostics: {
        isComplete: false,
        warnings: [],
        failure: 'startup-reconciliation-failed'
      }
    })

    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(repository.loadAllWithDiagnostics).toHaveBeenCalledWith({ mode: 'read-only' })
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(provenance.reconcileSessionDeletions).not.toHaveBeenCalled()
    expect(uploads.upgradeLegacySessionUploads).not.toHaveBeenCalled()
    expect(artifactStorage.prepareProjectReconciliation).not.toHaveBeenCalled()
    expect(artifactStorage.reconcileSession).not.toHaveBeenCalled()
    expect(log.info.mock.calls.map(([message]) => message)).toEqual([
      'operation started',
      'operation phase',
      'operation completed'
    ])
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'session-hydration',
        operationId: expect.any(String),
        mode: 'read-only',
        phase: 'load-authority',
        outcome: 'completed',
        status: 'degraded',
        sessionCount: 1,
        warningCount: 0,
        durationMs: expect.any(Number)
      })
    )
    const diagnosticPayload = JSON.stringify(log.info.mock.calls)
    expect(diagnosticPayload).not.toContain('Private analysis')
    expect(diagnosticPayload).not.toContain('/private/workspace')
  })

  it('reconciles durable Session grants only on the first complete startup scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const reconcileSessions = vi.fn().mockResolvedValue(undefined)
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      { reconcileSessions }
    )

    await coordinator.loadAll()
    await coordinator.loadAll()

    expect(reconcileSessions).toHaveBeenCalledOnce()
    expect(reconcileSessions).toHaveBeenCalledWith([
      { projectId: 'project-1', sessionId: 'session-1' }
    ])
  })

  it('keeps hydration available and records permission grant reconciliation degradation', async () => {
    const session = createSession({ title: 'Private analysis' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        reconcileSessions: vi
          .fn()
          .mockRejectedValue(new Error('permission registry unavailable for Private analysis'))
      },
      log
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)

    expect(log.warn).toHaveBeenCalledWith('permission grant reconciliation failed', {
      operation: 'session-hydration',
      phase: 'reconcile-permission-grants',
      outcome: 'degraded',
      errorCategory: 'error'
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Private analysis')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('permission registry unavailable')
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({ status: 'degraded', degradedReconciliationCount: 1 })
    )
  })

  it('does not prune durable Session grants from a partial startup scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi
        .fn()
        .mockResolvedValueOnce({ result, isComplete: false })
        .mockResolvedValueOnce({ result, isComplete: true })
    })
    const reconcileSessions = vi.fn().mockResolvedValue(undefined)
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      { reconcileSessions }
    )

    await coordinator.loadAll()
    await coordinator.loadAll()

    expect(reconcileSessions).not.toHaveBeenCalled()
  })

  it('reconciles path-free Upload copies only on the first complete load from multiple clients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-upload-startup-reconcile-'))
    const client = createProjectDbClient(root)
    await ensureProjectSchema(client)
    const content = Buffer.from('sample,value\na,1\n')
    const checksum = '5fe3f7b7e3492c63599954312dcb1e1d78488782753b6d3068c8d03292c7c1f6'
    const contentStorageKey =
      'uploads/project-1/session-1/upload-1/versions/upload-version-1/content'
    const finalPath = join(root, ...contentStorageKey.split('/'))
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', 'legacy.csv')
    await mkdir(dirname(finalPath), { recursive: true })
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(finalPath, content)
    await writeFile(legacyPath, content)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'legacy.csv',
        originalFilename: 'legacy.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey,
            filename: 'legacy.csv',
            originalFilename: 'legacy.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(content.byteLength),
            checksum
          }
        }
      }
    })
    const session = createSession({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'path-free upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              versionId: 'upload-version-1',
              versionNumber: 1,
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              size: content.byteLength,
              sha256: checksum
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const uploads = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    try {
      // No one-time normalizer participates here, representing pathsNormalizedAt already being set.
      await expect(coordinator.loadAll()).resolves.toBe(result)

      await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(finalPath)).resolves.toEqual(content)
      expect(repository.saveSession).not.toHaveBeenCalled()
      expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([session])
      expect(fileIndex.syncSession).toHaveBeenCalledWith(session)

      // A later renderer/task load is live-safe. Even if a historical path reappears, that call must
      // not remove bytes that another already-hydrated client could still be rendering.
      await writeFile(legacyPath, content)
      await expect(coordinator.loadAll()).resolves.toBe(result)
      await expect(readFile(legacyPath)).resolves.toEqual(content)
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists path-only Upload upgrades before startup indexing', async () => {
    const legacySession = createSession({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'legacy upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: '/legacy/legacy.csv',
              size: 11
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const upgradedSession = structuredClone(legacySession)
    upgradedSession.messages[0].uploads = [
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'legacy.csv',
        originalName: 'legacy.csv',
        size: 11,
        sha256: 'a'.repeat(64)
      }
    ]
    const result = { sessions: [legacySession], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(upgradedSession)
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions).toEqual([upgradedSession])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(1, legacySession, {
      mode: 'live-save'
    })
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(2, upgradedSession, {
      mode: 'reconcile'
    })
    expect(repository.saveSession).toHaveBeenCalledWith(upgradedSession)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([upgradedSession])
    expect(fileIndex.syncSession).toHaveBeenCalledWith(upgradedSession)
  })

  it('retains every legacy source when one Upload prevents a complete startup projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-upload-startup-partial-'))
    const client = createProjectDbClient(root)
    await ensureProjectSchema(client)
    const content = Buffer.from('sample,value\na,1\n')
    const retainedPath = join(root, 'uploads', 'default-project', 'session-1', 'retained.csv')
    const missingPath = join(root, 'uploads', 'default-project', 'session-1', 'missing.csv')
    await mkdir(dirname(retainedPath), { recursive: true })
    await writeFile(retainedPath, content)
    const legacySession = createSession({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'partially recoverable uploads',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-retained',
              sessionId: 'session-1',
              name: 'retained.csv',
              originalName: 'retained.csv',
              path: retainedPath,
              size: content.byteLength
            },
            {
              id: 'upload-missing',
              sessionId: 'session-1',
              name: 'missing.csv',
              originalName: 'missing.csv',
              path: missingPath,
              size: content.byteLength
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const result = { sessions: [legacySession], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const uploads = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const upgradeSpy = vi.spyOn(uploads, 'upgradeLegacySessionUploads')
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    try {
      await expect(coordinator.loadAll()).resolves.toBe(result)

      await vi.waitFor(async () => {
        await expect(
          client.uploadVersion.findFirst({
            where: { uploadFileId: 'upload-retained', state: 'ready' }
          })
        ).resolves.toBeTruthy()
      })
      await expect(readFile(retainedPath)).resolves.toEqual(content)
      expect(upgradeSpy).toHaveBeenCalledWith(legacySession, { mode: 'live-save' })
      expect(repository.saveSession).not.toHaveBeenCalled()
      expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
      expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('closes destructive startup cleanup after an incomplete first load', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(legacySession)
    const incomplete = {
      result: { sessions: [], manifest: { version: 1 as const } },
      isComplete: false
    }
    const complete = {
      result: { sessions: [legacySession], manifest: { version: 1 as const } },
      isComplete: true
    }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi
        .fn()
        .mockResolvedValueOnce(incomplete)
        .mockResolvedValueOnce(complete)
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(upgradedSession)
    }
    const projectReconciliation = createProjectReconciliationSnapshot()
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn().mockResolvedValue(projectReconciliation),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      uploads,
      artifactStorage
    )

    await expect(coordinator.loadAll()).resolves.toBe(incomplete.result)
    await expect(coordinator.loadAll()).resolves.toEqual({
      sessions: [upgradedSession],
      manifest: complete.result.manifest,
      diagnostics: { isComplete: true, warnings: [] }
    })

    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledOnce()
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(legacySession, {
      mode: 'live-save'
    })
    expect(repository.saveSession).toHaveBeenCalledWith(upgradedSession)
    expect(artifactStorage.reconcileSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      upgradedSession,
      { removeOrphanStaging: false, projectReconciliation }
    )
  })

  it('marks startup reconciliation incomplete when one Session Upload reconciliation fails', async () => {
    const first = createLegacyUploadSession('session-1')
    const upgradedFirst = toVersionedUploadSession(first)
    const second = createLegacyUploadSession('session-2')
    const result = { sessions: [first, second], manifest: { version: 1 as const } }
    let persistedFirst: PersistedChatSession | undefined
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true }),
      saveSession: vi.fn(async (session) => {
        persistedFirst = structuredClone(session)
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi
        .fn()
        .mockResolvedValueOnce(upgradedFirst)
        .mockRejectedValueOnce(new Error('upload reconciliation failed'))
    }
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions).toEqual([upgradedFirst, second])
    expect(persistedFirst).toEqual(upgradedFirst)
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(1, first, {
      mode: 'live-save'
    })
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(2, upgradedFirst, {
      mode: 'reconcile'
    })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
  })

  it('hydrates an upgraded Session when its authoritative startup save fails', async () => {
    const session = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(session)
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true }),
      saveSession: vi.fn().mockRejectedValue(new Error('session file unavailable'))
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(upgradedSession)
    }
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions).toEqual([upgradedSession])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledOnce()
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(session, {
      mode: 'live-save'
    })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
  })

  it('does not roll back upgraded hydration when downstream startup reconciliation fails', async () => {
    const session = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(session)
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(upgradedSession)
    }
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({
      markReconciliationIncomplete,
      reconcileActiveSessions: vi.fn().mockRejectedValue(new Error('index unavailable'))
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions).toEqual([upgradedSession])
    expect(repository.saveSession).toHaveBeenCalledWith(upgradedSession)
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
  })

  it('prepares one Artifact reconciliation snapshot for sessions in the same Project', async () => {
    const sessions = [createSession(), createSession({ id: 'session-2' })]
    const result = { sessions, manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const projectSnapshot = createProjectReconciliationSnapshot()
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn().mockResolvedValue(projectSnapshot),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    await coordinator.loadAll()

    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledOnce()
    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledWith('project-1')
    expect(artifactStorage.reconcileSession).toHaveBeenCalledTimes(2)
    for (const session of sessions) {
      expect(artifactStorage.reconcileSession).toHaveBeenCalledWith(
        'project-1',
        session.id,
        session,
        {
          removeOrphanStaging: true,
          projectReconciliation: projectSnapshot
        }
      )
    }
  })

  it('prepares separate Artifact reconciliation snapshots for different Projects', async () => {
    const sessions = [
      createSession(),
      createSession({ id: 'session-2' }),
      createSession({ id: 'session-3', projectId: 'project-2' })
    ]
    const result = { sessions, manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const snapshots = new Map<string, ArtifactProjectReconciliationSnapshot>([
      ['project-1', createProjectReconciliationSnapshot()],
      ['project-2', createProjectReconciliationSnapshot()]
    ])
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn(async (projectId: string) => snapshots.get(projectId)!),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    await coordinator.loadAll()

    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledTimes(2)
    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledWith('project-1')
    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledWith('project-2')
    for (const session of sessions) {
      expect(artifactStorage.reconcileSession).toHaveBeenCalledWith(
        session.projectId,
        session.id,
        session,
        {
          removeOrphanStaging: true,
          projectReconciliation: snapshots.get(session.projectId)
        }
      )
    }
  })

  it('marks Files incomplete when Project reconciliation preparation fails', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn().mockRejectedValue(new Error('scan failed')),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)

    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(artifactStorage.reconcileSession).not.toHaveBeenCalled()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
  })

  it('persists recovered Artifact Versions on their owning message without replay churn', async () => {
    const originalSession = materializeSessionConversationGraph(
      createSession({
        filesRevision: 4,
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'streaming',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    )
    let durableSession = originalSession
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions: [durableSession], manifest: { version: 1 as const } },
        isComplete: true
      })),
      saveSession: vi.fn(async (session) => {
        durableSession = structuredClone(session)
      })
    })
    const recoveredArtifact = createRecoveredArtifact()
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          { messageId: 'message-1', artifacts: [recoveredArtifact, recoveredArtifact] }
        ]
      })
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const first = await coordinator.loadAll()
    const recoveredSession = first.sessions[0]

    // Message associations use ArtifactFile.id (the Artifact Version id), not lineage artifactId.
    expect(recoveredSession.messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(recoveredSession.conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(recoveredSession.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-version-1',
        artifactId: 'artifact-lineage-1',
        versionId: 'artifact-version-1',
        versionNumber: 1,
        sha256: 'a'.repeat(64)
      })
    ])
    expect(recoveredSession.filesRevision).toBe(5)
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([recoveredSession])
    expect(fileIndex.syncSession).toHaveBeenCalledWith(recoveredSession)

    const replayed = await coordinator.loadAll()
    expect(replayed.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(replayed.sessions[0].artifacts).toHaveLength(1)
    expect(replayed.sessions[0].filesRevision).toBe(5)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('replaces a recovered Artifact Version legacy alias instead of preserving two projections', async () => {
    const legacyAlias = createLegacyArtifactAlias()
    const originalSession = materializeSessionConversationGraph(
      createSession({
        filesRevision: 4,
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'complete',
            eventIds: [],
            artifactIds: [legacyAlias.id],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        artifacts: [legacyAlias]
      })
    )
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [originalSession], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          { messageId: 'message-1', artifacts: [createRecoveredArtifact()] }
        ]
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const loaded = await coordinator.loadAll()
    const recoveredSession = loaded.sessions[0]

    expect(recoveredSession.messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(recoveredSession.conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(recoveredSession.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-version-1',
        versionId: 'artifact-version-1',
        sha256: 'a'.repeat(64)
      })
    ])
    expect(recoveredSession.filesRevision).toBe(5)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('normalizes an already duplicated historical Artifact Version without recovery input', async () => {
    const legacyAlias = createLegacyArtifactAlias()
    const nativeVersion = createPersistedRecoveredArtifact()
    const originalSession = materializeSessionConversationGraph(
      createSession({
        filesRevision: 7,
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'complete',
            eventIds: [],
            artifactIds: [legacyAlias.id, nativeVersion.id],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        artifacts: [legacyAlias, nativeVersion]
      })
    )
    let durableSession = originalSession
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions: [durableSession], manifest: { version: 1 as const } },
        isComplete: true
      })),
      saveSession: vi.fn(async (session) => {
        durableSession = structuredClone(session)
      })
    })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const loaded = await coordinator.loadAll()
    const normalizedSession = loaded.sessions[0]

    expect(normalizedSession.messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(normalizedSession.conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(normalizedSession.artifacts).toEqual([nativeVersion])
    expect(normalizedSession.filesRevision).toBe(8)
    expect(repository.saveSession).toHaveBeenCalledOnce()

    const replayed = await coordinator.loadAll()
    expect(replayed.sessions[0]).toEqual(normalizedSession)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('retries a failed historical Artifact alias write-back without replay churn', async () => {
    const legacyAlias = createLegacyArtifactAlias()
    const nativeVersion = createPersistedRecoveredArtifact()
    const originalSession = materializeSessionConversationGraph(
      createSession({
        filesRevision: 7,
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'historical result',
            status: 'complete',
            eventIds: ['event-1'],
            artifactIds: [legacyAlias.id, nativeVersion.id],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        artifacts: [legacyAlias, nativeVersion]
      })
    )
    let durableSession = originalSession
    let writeAttempt = 0
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions: [durableSession], manifest: { version: 1 as const } },
        isComplete: true
      })),
      saveSession: vi.fn(async (session) => {
        writeAttempt += 1
        if (writeAttempt === 1) throw new Error('session json is read-only')
        durableSession = structuredClone(session)
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ markReconciliationIncomplete }),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const failedWriteView = await coordinator.loadAll()
    expect(failedWriteView.sessions[0].messages[0]).toMatchObject({
      content: 'historical result',
      eventIds: ['event-1'],
      artifactIds: ['artifact-version-1'],
      createdAt: 1,
      updatedAt: 2
    })
    expect(failedWriteView.sessions[0].artifacts).toEqual([nativeVersion])
    expect(failedWriteView.diagnostics?.failure).toBe('startup-reconciliation-failed')
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()

    const retried = await coordinator.loadAll()
    expect(retried.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(repository.saveSession).toHaveBeenCalledTimes(2)

    const replayed = await coordinator.loadAll()
    expect(replayed.sessions[0]).toEqual(retried.sessions[0])
    expect(repository.saveSession).toHaveBeenCalledTimes(2)
  })

  it('returns the recovered Session view and retries when its JSON save fails', async () => {
    const session = materializeSessionConversationGraph(
      createSession({
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'streaming',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    )
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true }),
      saveSession: vi
        .fn()
        .mockRejectedValueOnce(new Error('session json is read-only'))
        .mockResolvedValueOnce(undefined)
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const provenance = createProvenancePersistence()
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          {
            messageId: 'message-1',
            artifacts: [
              createRecoveredArtifact({
                checksum: 'b'.repeat(64),
                name: 'result.txt',
                path: '/managed/result.txt',
                fileUrl: 'file:///managed/result.txt',
                size: 6
              })
            ]
          }
        ]
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance,
      undefined,
      artifactStorage
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(loaded.sessions[0].conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(loaded.sessions[0].artifacts?.[0]).toMatchObject({ id: 'artifact-version-1' })
    expect(loaded.sessions[0].filesRevision).toBe(2)
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()

    const retried = await coordinator.loadAll()
    expect(retried.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledTimes(2)
    expect(repository.saveSession).toHaveBeenCalledTimes(2)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledOnce()
    expect(fileIndex.syncSession).toHaveBeenCalledOnce()
  })

  it('retries the attachment without saving JSON when Message snapshot capture fails', async () => {
    const session = materializeSessionConversationGraph(
      createSession({
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'streaming',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    )
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [session], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const provenance = createProvenancePersistence({
      captureFinalizedMessages: vi
        .fn()
        .mockRejectedValueOnce(new Error('snapshot storage is read-only'))
        .mockResolvedValueOnce(undefined)
    })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          { messageId: 'message-1', artifacts: [createRecoveredArtifact()] }
        ]
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance,
      undefined,
      artifactStorage
    )

    const first = await coordinator.loadAll()
    expect(first.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()

    const retried = await coordinator.loadAll()
    expect(retried.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledTimes(2)
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledOnce()
    expect(fileIndex.syncSession).toHaveBeenCalledOnce()
  })

  it('keeps earlier recovered Sessions when a later reconciliation fails', async () => {
    const firstSession = materializeSessionConversationGraph(
      createSession({
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'first result',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    )
    const secondSession = createSession({ id: 'session-2', title: 'Second Session' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [firstSession, secondSession], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi
        .fn()
        .mockResolvedValueOnce({
          recoveredMessageArtifacts: [
            { messageId: 'message-1', artifacts: [createRecoveredArtifact()] }
          ]
        })
        .mockRejectedValueOnce(new Error('artifact database unavailable'))
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(loaded.sessions[0].conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(loaded.sessions[1]).toBe(secondSession)
    expect(repository.saveSession).toHaveBeenCalledWith(loaded.sessions[0])
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
  })

  it('reconciles active owners before syncing sessions from a complete startup scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    let isReconciled = false
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const syncSession = vi.fn().mockResolvedValue([])
    const fileIndex = createFileIndex({
      syncSession,
      reconcileActiveSessions: vi.fn(async () => {
        isReconciled = true
      })
    })
    syncSession.mockImplementation(async () => {
      expect(isReconciled).toBe(true)
      return []
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.loadAll()

    expect(syncSession).toHaveBeenCalledOnce()
  })

  it('marks startup reconciliation incomplete when a Session file-index sync fails', async () => {
    const session = createSession({ title: 'Private analysis', cwd: '/private/workspace' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({
      markReconciliationIncomplete,
      syncSession: vi
        .fn()
        .mockRejectedValue(new Error('file index database is locked at /private/files.sqlite'))
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(coordinator.loadAll()).resolves.toMatchObject({
      diagnostics: {
        isComplete: false,
        failure: 'startup-reconciliation-failed'
      }
    })
    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Private analysis' }],
      isComplete: false
    })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledWith(
      'operation failed',
      expect.objectContaining({
        operation: 'session-hydration',
        operationId: expect.any(String),
        mode: 'reconcile',
        startupCleanupEligible: true,
        phase: 'reconcile-derived-state',
        outcome: 'failed',
        status: 'degraded',
        hydrationAvailable: true,
        sessionCount: 1,
        warningCount: 0,
        errorCategory: 'error',
        durationMs: expect.any(Number)
      })
    )
    const diagnosticPayload = JSON.stringify(log.error.mock.calls)
    expect(diagnosticPayload).not.toContain('Private analysis')
    expect(diagnosticPayload).not.toContain('file index database is locked')
    expect(diagnosticPayload).not.toContain('/private/files.sqlite')
  })

  it('retries surviving project sessions after deleting a collision owner', async () => {
    const owner = createSession()
    const survivor = createSession({ id: 'session-2' })
    const result = { sessions: [owner, survivor], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi
        .fn()
        .mockResolvedValueOnce({ result, isComplete: true })
        .mockResolvedValueOnce({
          result: { sessions: [survivor], manifest: { version: 1 as const } },
          isComplete: true
        })
    })
    const fileIndex = createFileIndex()
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)
    await coordinator.loadAll()
    vi.mocked(fileIndex.syncSession).mockClear()
    vi.mocked(fileIndex.syncSession).mockResolvedValueOnce(['artifact'])

    await coordinator.deleteSession('project-1', 'session-1')

    expect(fileIndex.syncSession).toHaveBeenCalledTimes(1)
    expect(fileIndex.syncSession).toHaveBeenCalledWith(survivor)
    expect(onFilesChanged).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1',
      sessionId: 'session-2',
      sources: ['artifact'],
      kind: 'upsert'
    })
    expect(onFilesChanged).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1',
      sessionId: 'session-1',
      sources: ['artifact', 'upload'],
      kind: 'delete'
    })
  })

  it('marks the index incomplete when the sessions scan is partial', async () => {
    const session = createSession({ title: 'Private analysis' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const warnings = [
      {
        kind: 'unreadable' as const,
        projectId: 'project-1',
        fileName: 'private-session-2.json',
        recovered: false
      }
    ]
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: false, warnings })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )
    const reconcile = vi.fn(async () => undefined)
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ reconcile }))

    const loaded = await coordinator.loadAll()

    expect(loaded).toBe(result)
    expect(result).toMatchObject({ diagnostics: { isComplete: false, warnings } })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'session-hydration',
        phase: 'load-authority',
        outcome: 'completed',
        status: 'partial',
        sessionCount: 1,
        warningCount: 1
      })
    )
    const diagnosticPayload = JSON.stringify(log.info.mock.calls)
    expect(diagnosticPayload).not.toContain('Private analysis')
    expect(diagnosticPayload).not.toContain('private-session-2.json')
  })

  it('marks reconciliation incomplete when startup Provenance recovery fails', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const provenance = {
      validateFinalizedMessageBindings: vi.fn(),
      captureFinalizedMessages: vi.fn(),
      reconcileSessionDeletions: vi.fn().mockRejectedValue(new Error('recovery failed')),
      prepareSessionDeletion: vi.fn(),
      completeSessionDeletion: vi.fn(),
      abortSessionDeletion: vi.fn()
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)
    expect(result).toMatchObject({
      diagnostics: {
        isComplete: false,
        failure: 'startup-reconciliation-failed'
      }
    })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
  })

  it('keeps chat hydration available when one session cannot be indexed', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const fileIndex = createFileIndex({
      syncSession: vi.fn().mockRejectedValue(new Error('missing managed file'))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.loadAll()).resolves.toBe(result)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([session])
  })

  it('leaves the project index untouched when authoritative Session rename fails', async () => {
    const repository = createSessionRepository({
      deleteProjectSessions: vi.fn().mockRejectedValueOnce(new Error('directory busy'))
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow('directory busy')
    expect(fileIndex.softDeleteProject).not.toHaveBeenCalled()
    await expect(coordinator.saveSession(createSession())).resolves.toMatchObject({
      id: 'session-1'
    })
  })

  it('retains the Project tombstone and retries a derived index failure after Session commit', async () => {
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('prepared')
    })
    const fileIndex = createFileIndex({
      softDeleteProject: vi
        .fn()
        .mockRejectedValueOnce(new Error('index unavailable'))
        .mockResolvedValue('delete-project-operation')
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'index unavailable'
    )
    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/project.*deleted/i)
    expect(repository.deleteProjectSessions).toHaveBeenCalledOnce()

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(repository.deleteProjectSessions).toHaveBeenCalledTimes(2)
    expect(fileIndex.softDeleteProject).toHaveBeenCalledTimes(2)
  })

  it('retries committed tombstone cleanup after persisting its path-free Session projection', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(legacySession)
    let durableSession = legacySession
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
        sessions: [durableSession],
        isComplete: true
      })),
      saveCommittedProjectSession: vi.fn(async (session) => {
        durableSession = session
      })
    })
    let terminalAttempts = 0
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (session, options) => {
        if (options?.mode === 'live-save') return upgradedSession
        terminalAttempts += 1
        if (terminalAttempts === 1) throw new Error('terminal cleanup interrupted')
        return session
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'terminal cleanup interrupted'
    )
    expect(repository.saveCommittedProjectSession).toHaveBeenCalledWith(upgradedSession)
    expect(repository.markCommittedProjectSessionsPrepared).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(repository.saveCommittedProjectSession).toHaveBeenCalledOnce()
    expect(repository.markCommittedProjectSessionsPrepared).toHaveBeenCalledOnce()
    expect(repository.deleteProjectSessions).toHaveBeenCalledOnce()
  })

  it('reconciles retained Upload copies before project Session and index authority are removed', async () => {
    const order: string[] = []
    const session = toVersionedUploadSession(createLegacyUploadSession('session-1'))
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: true
      }),
      deleteProjectSessions: vi.fn(async () => {
        order.push('delete-json')
      })
    })
    const fileIndex = createFileIndex({
      softDeleteProject: vi.fn(async () => {
        order.push('soft-delete-index')
        return 'delete-project-operation'
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async () => {
        order.push('reconcile-upload-copy')
        return session
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await coordinator.deleteProjectSessions('project-1')

    expect(order).toEqual(['reconcile-upload-copy', 'delete-json', 'soft-delete-index'])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(session, {
      mode: 'terminal-delete'
    })
  })

  it('terminal-cleans readable Sessions before deleting incomplete Project authority', async () => {
    const order: string[] = []
    const session = toVersionedUploadSession(createLegacyUploadSession('session-1'))
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: false
      }),
      deleteProjectSessions: vi.fn(async () => {
        order.push('delete-project-sessions')
      })
    })
    const fileIndex = createFileIndex({
      markReconciliationIncomplete: vi.fn(() => {
        order.push('mark-incomplete')
      }),
      softDeleteProject: vi.fn(async () => {
        order.push('soft-delete-index')
        return 'delete-project-operation'
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async () => {
        order.push('terminal-cleanup')
        return session
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })

    expect(order).toEqual([
      'mark-incomplete',
      'terminal-cleanup',
      'delete-project-sessions',
      'soft-delete-index'
    ])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(session, {
      mode: 'terminal-delete'
    })
  })

  it('preserves incomplete orphaned tombstone authority instead of adopting its readable subset', async () => {
    const session = toVersionedUploadSession(createLegacyUploadSession('session-1'))
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: false
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(session)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      uploads
    )

    await expect(
      coordinator.deleteProjectSessions('project-1', {
        requireExistingUploadAuthority: true
      })
    ).rejects.toThrow(/incomplete Session authority/i)

    expect(uploads.upgradeLegacySessionUploads).not.toHaveBeenCalled()
    expect(repository.markCommittedProjectSessionsPrepared).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('returns orphan-retained only for positively missing Upload authority', async () => {
    const session = createLegacyUploadSession('session-1')
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: true
      })
    })
    const fileIndex = createFileIndex()
    const uploads = {
      upgradeLegacySessionUploads: vi
        .fn()
        .mockRejectedValue(new OrphanLegacyUploadAuthorityMissingError('missing Upload authority'))
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(
      coordinator.deleteProjectSessions('project-1', {
        requireExistingUploadAuthority: true
      })
    ).resolves.toEqual({
      status: 'orphan-retained',
      reason: 'missing-upload-authority'
    })

    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.softDeleteProject).toHaveBeenCalledWith('project-1')
    expect(repository.markCommittedProjectSessionsPrepared).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('rejects orphan retention when the Project index cannot be soft-deleted', async () => {
    const session = createLegacyUploadSession('session-1')
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: true
      })
    })
    const fileIndex = createFileIndex({
      softDeleteProject: vi.fn().mockRejectedValue(new Error('index temporarily unavailable'))
    })
    const uploads = {
      upgradeLegacySessionUploads: vi
        .fn()
        .mockRejectedValue(new OrphanLegacyUploadAuthorityMissingError('missing Upload authority'))
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(
      coordinator.deleteProjectSessions('project-1', {
        requireExistingUploadAuthority: true
      })
    ).rejects.toThrow('index temporarily unavailable')

    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(repository.markCommittedProjectSessionsPrepared).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('aborts Project deletion on transient Upload cleanup failure and retries from intact authority', async () => {
    const first = createLegacyUploadSession('session-1')
    const upgradedFirst = toVersionedUploadSession(first)
    const second = createLegacyUploadSession('session-2')
    const order: string[] = []
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [first, second],
        isComplete: true
      }),
      saveSession: vi.fn(async (session) => {
        order.push(`save:${session.id}`)
      })
    })
    let secondUpgradeAttempts = 0
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (session, options) => {
        order.push(`${session.id}:${options?.mode}`)
        if (session.id === 'session-1') return upgradedFirst
        secondUpgradeAttempts += 1
        if (secondUpgradeAttempts === 1) throw new Error('second upload upgrade failed')
        return toVersionedUploadSession(second)
      })
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'second upload upgrade failed'
    )

    expect(order).toEqual([
      'session-1:live-save',
      'save:session-1',
      'session-1:terminal-delete',
      'session-2:live-save'
    ])
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(repository.saveSession).toHaveBeenCalledWith(upgradedFirst)
    expect(fileIndex.softDeleteProject).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(fileIndex.softDeleteProject).toHaveBeenCalledWith('project-1')
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-1')
  })

  it('retains a legacy source and aborts Project deletion when path-free projection save fails', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(legacySession)
    let legacySourceRemoved = false
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [legacySession],
        isComplete: true
      }),
      saveSession: vi.fn().mockRejectedValue(new Error('session file unavailable'))
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (_session, options) => {
        if (options?.mode === 'terminal-delete') legacySourceRemoved = true
        return upgradedSession
      })
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'session file unavailable'
    )

    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledOnce()
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(legacySession, {
      mode: 'live-save'
    })
    expect(legacySourceRemoved).toBe(false)
    expect(fileIndex.markReconciliationIncomplete).not.toHaveBeenCalled()
    expect(fileIndex.softDeleteProject).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('retains a proven unsafe Upload replacement while committing Project deletion', async () => {
    const session = toVersionedUploadSession(createLegacyUploadSession('session-1'))
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: true
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi
        .fn()
        .mockRejectedValue(
          new UnsafeLegacyUploadResidualError('legacy path contains unrelated bytes')
        )
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })

    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.softDeleteProject).toHaveBeenCalledWith('project-1')
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-1')
  })

  it('rejects late session saves after a project session directory was deleted', async () => {
    const repository = createSessionRepository()
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.deleteProjectSessions('project-1')

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/project.*deleted/i)
  })

  it('does not turn a committed project-session deletion into a failure when notification throws', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex(), () => {
      throw new Error('renderer unavailable')
    })

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/project.*deleted/i)
  })

  it('does not turn a committed session deletion into a failure when notification throws', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex(), () => {
      throw new Error('renderer unavailable')
    })

    await expect(coordinator.deleteSession('project-1', 'session-1')).resolves.toBeUndefined()
    expect(repository.deleteSession).toHaveBeenCalledWith('project-1', 'session-1')
    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/deleted/)
  })

  it('cleans unread state only after removing one authoritative session', async () => {
    const order: string[] = []
    const repository = createSessionRepository({
      deleteSession: vi.fn(async () => {
        order.push('delete-json')
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(
      createSessionDeletionHandlers({
        commit: vi.fn(async (sessionIds) => {
          order.push(`commit:${sessionIds.join(',')}`)
        })
      })
    )

    await coordinator.deleteSession('project-1', 'session-1')

    expect(order).toEqual(['delete-json', 'commit:session-1'])
  })

  it('does not clean unread state when the authoritative session delete fails', async () => {
    const repository = createSessionRepository({
      deleteSession: vi.fn().mockRejectedValue(new Error('disk locked'))
    })
    const commit = vi.fn(async () => undefined)
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ commit }))

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')

    expect(commit).not.toHaveBeenCalled()
  })

  it('cleans every project session after removing project authority', async () => {
    const order: string[] = []
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('live'),
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [createSession(), createSession({ id: 'session-2' })],
        isComplete: true
      }),
      deleteProjectSessions: vi.fn(async () => {
        order.push('delete-project-json')
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(
      createSessionDeletionHandlers({
        commit: vi.fn(async (sessionIds) => {
          order.push(`commit:${sessionIds.join(',')}`)
        })
      })
    )

    await coordinator.deleteProjectSessions('project-1')

    expect(order).toEqual(['delete-project-json', 'commit:session-1,session-2'])
  })

  it('does not clean unread state when live project authority remains after failure', async () => {
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('live'),
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [createSession()],
        isComplete: true
      }),
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('directory busy'))
    })
    const commit = vi.fn(async () => undefined)
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ commit }))

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow('directory busy')

    expect(commit).not.toHaveBeenCalled()
    await expect(coordinator.saveSession(createSession())).resolves.toMatchObject({
      id: 'session-1'
    })
  })

  it('cleans unread state when replaying a project tombstone', async () => {
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('prepared'),
      loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [createSession()],
        isComplete: true
      })
    })
    const commit = vi.fn(async () => undefined)
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ commit }))

    await coordinator.deleteProjectSessions('project-1')

    expect(commit).toHaveBeenCalledWith(['session-1'])
  })

  it('keeps committed session deletion successful when unread cleanup rejects', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(
      createSessionDeletionHandlers({
        commit: vi.fn().mockRejectedValue(new Error('badge database locked'))
      })
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).resolves.toBeUndefined()
    expect(repository.deleteSession).toHaveBeenCalledWith('project-1', 'session-1')
  })

  it('reconciles surviving sessions after a successful session deletion', async () => {
    const survivor = createSession({ id: 'session-2' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [survivor], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.deleteSession('project-1', 'session-1')

    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([survivor])
  })

  it('routes manifest writes through the same mutation queue', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveManifest({ lastProjectId: 'project-1', lastSessionId: 'session-1' })

    expect(repository.saveManifest).toHaveBeenCalledWith({
      lastProjectId: 'project-1',
      lastSessionId: 'session-1'
    })
  })

  it('does not broadcast a files change when the files revision is already indexed', async () => {
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex({ syncSession: vi.fn().mockResolvedValue([]) }),
      onFilesChanged
    )

    await coordinator.saveSession(createSession())

    expect(onFilesChanged).not.toHaveBeenCalled()
  })

  it('broadcasts only the file sources changed by the index transaction', async () => {
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex({ syncSession: vi.fn().mockResolvedValue(['upload']) }),
      onFilesChanged
    )

    await coordinator.saveSession(createSession())

    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      sources: ['upload'],
      kind: 'upsert'
    })
  })

  it('broadcasts a reset when a saved session cannot be indexed', async () => {
    const onFilesChanged = vi.fn()
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({
        syncSession: vi.fn().mockRejectedValue(new Error('managed file is unreadable'))
      }),
      onFilesChanged
    )

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(
      'managed file is unreadable'
    )

    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })

  it('force-syncs the complete scan before repair clears the global reconciliation marker', async () => {
    const targetSession = createSession()
    const otherSession = createSession({ id: 'session-2', projectId: 'project-2' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [targetSession, otherSession], manifest: { version: 1 } },
        isComplete: true
      })
    })
    const fileIndex = createFileIndex({ syncSession: vi.fn().mockResolvedValue([]) })
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)
    const repairProjectFiles = (
      coordinator as unknown as { repairProjectFiles(projectId: string): Promise<void> }
    ).repairProjectFiles

    await repairProjectFiles.call(coordinator, 'project-1')

    expect(fileIndex.syncSession).toHaveBeenCalledTimes(4)
    expect(fileIndex.syncSession).toHaveBeenCalledWith(targetSession, { force: true })
    expect(fileIndex.syncSession).toHaveBeenCalledWith(otherSession, { force: true })
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([targetSession, otherSession])
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })

  it('resolves repair when a transient first-pass sync succeeds after reconciliation', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [session], manifest: { version: 1 } },
        isComplete: true
      })
    })
    const syncSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce([])
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ syncSession })
    )

    await expect(coordinator.repairProjectFiles('project-1')).resolves.toBeUndefined()
    expect(syncSession).toHaveBeenCalledTimes(2)
  })

  it('marks the index incomplete and broadcasts reset when repair sees a partial scan', async () => {
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [], manifest: { version: 1 } },
        isComplete: false
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)

    await expect(coordinator.repairProjectFiles('project-1')).rejects.toThrow(/sessions directory/i)

    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })
})

const createSessionRepository = (
  overrides: Partial<SessionMutationRepository> = {}
): SessionMutationRepository => ({
  loadAllWithDiagnostics: vi.fn().mockResolvedValue({
    result: { sessions: [], manifest: { version: 1 } },
    isComplete: true
  }),
  loadProjectWithDiagnostics: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }),
  loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
    sessions: [],
    isComplete: true
  }),
  loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'missing' }),
  saveSession: vi.fn().mockResolvedValue(undefined),
  saveCommittedProjectSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
  getProjectSessionDeletionState: vi.fn().mockResolvedValue('absent'),
  markCommittedProjectSessionsPrepared: vi.fn().mockResolvedValue(undefined),
  completeProjectSessionDeletion: vi.fn().mockResolvedValue(undefined),
  listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue([]),
  saveManifest: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

const createFileIndex = (overrides: Partial<SessionFileIndex> = {}): SessionFileIndex => ({
  syncSession: vi.fn().mockResolvedValue(['artifact', 'upload']),
  softDeleteSession: vi.fn().mockResolvedValue('delete-session-operation'),
  restoreSession: vi.fn().mockResolvedValue(undefined),
  softDeleteProject: vi.fn().mockResolvedValue('delete-project-operation'),
  reconcileActiveSessions: vi.fn().mockResolvedValue(undefined),
  markReconciliationIncomplete: vi.fn(),
  ...overrides
})

const createSessionDeletionHandlers = (
  overrides: Partial<SessionDeletionHandlers> = {}
): SessionDeletionHandlers => ({
  commit: vi.fn().mockResolvedValue(undefined),
  reconcile: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

const createProvenancePersistence = (
  overrides: Partial<SessionProvenancePersistence> = {}
): SessionProvenancePersistence => ({
  validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
  captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
  reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
  prepareSessionDeletion: vi
    .fn()
    .mockResolvedValue({ kind: 'ordinary', projectId: 'project-1', sessionId: 'session-1' }),
  completeSessionDeletion: vi.fn().mockResolvedValue(undefined),
  abortSessionDeletion: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

const createDeferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

type TestLogger = Logger & {
  [Method in keyof Logger]: ReturnType<typeof vi.fn<Logger[Method]>>
}

const createTestLogger = (): TestLogger =>
  ({
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>()
  }) satisfies Logger

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}
