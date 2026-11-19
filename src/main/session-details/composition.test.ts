import { afterEach, expect, it, vi } from 'vitest'
import type { ApplicationModuleBuilder } from '../application-runtime'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  CODEX_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID
} from '../../shared/settings-runtime'
import { RestrictedInferenceRunner } from '../acp/restricted-inference-runner'
import { SessionDetailsModelOwner } from '../settings/session-details-model-owner'
import { composeSessionSurfaces } from '../composition/session-surfaces'

const persistenceHandlers = vi.hoisted(() => ({ loadOne: vi.fn() }))

// Keep unrelated surface installation outside this feature's behavioral boundary.
vi.mock('../desktop-surface-declarations', () => ({ createSpecialistElectronSurface: vi.fn() }))
vi.mock('../specialist/application-commands', () => ({ createSpecialistApplicationOwner: vi.fn() }))
vi.mock('../session-persistence/ipc', () => ({
  withSessionDeletionCleanup: (operation: unknown) => operation,
  createSessionPersistenceHandlersWithAttributionAuthority: vi.fn(() => persistenceHandlers)
}))
vi.mock('../runtime-metadata', () => ({ runtimeMetadata: () => ({ version: 'test' }) }))
afterEach(() => {
  persistenceHandlers.loadOne = vi.fn()
  vi.restoreAllMocks()
})

it.each(
  (
    [
      { type: 'codex-isolated', status: 'queued' },
      { type: 'codex-shared', status: 'queued' },
      { type: 'codex-isolated', status: 'failed' },
      { type: 'codex-shared', status: 'failed' }
    ] as const
  ).flatMap((entry) =>
    (['codex', 'open-science-agent'] as const).map((frameworkId) => ({ ...entry, frameworkId }))
  )
)(
  'generates $status Session details through the composed $frameworkId/$type subscription runner',
  async ({ type, status, frameworkId }) => {
    const providerId =
      type === 'codex-shared' ? CODEX_SHARED_PROVIDER_ID : CODEX_SUBSCRIPTION_PROVIDER_ID
    let session: PersistedChatSession = {
      id: 'session',
      projectId: 'project',
      title: 'Fallback',
      description: '',
      cwd: process.cwd(),
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      agentFrameworkId: frameworkId,
      agentModel: 'model',
      agentConfiguration: { providerId, model: 'model', reasoningEffort: 'high' },
      sessionDetailsSource: 'fallback',
      sessionDetailsGeneration: {
        requestId: 'request',
        sourceMessageId: 'message',
        queuedAt: 1,
        ...(status === 'failed'
          ? { status, completedAt: 2, usageUnavailable: true as const }
          : { status })
      },
      messages: [
        {
          id: 'message',
          role: 'user',
          content: 'Investigate proteins',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
    const models = new SessionDetailsModelOwner({
      repository: {
        getSettings: async () => ({
          version: 2,
          providers: [{ id: providerId, type, name: 'Codex' }]
          // Exercise the default inherited details-model configuration.
        })
      },
      providers: {
        resolveRuntimeTarget: vi.fn(() => {
          if (frameworkId === 'codex') throw new Error('Subscription must retain its native route.')
          return {
            providerId,
            providerType: type,
            effectiveModel: 'model',
            apiEndpoints: ['responses'],
            frameworkCompatible: true
          }
        })
      },
      backendResolver: { captureConfiguredSelection: vi.fn() }
    } as unknown as ConstructorParameters<typeof SessionDetailsModelOwner>[0])
    const run = vi.spyOn(RestrictedInferenceRunner.prototype, 'run').mockResolvedValue({
      text: '{"title":"Proteins","description":"Investigate proteins"}',
      stopReason: 'end_turn',
      frameworkId,
      model: 'model'
    })
    const modules: ApplicationModuleBuilder = {
      add: async (dependencies, create) => (await create(dependencies)).capability
    }
    const publish = vi.fn()
    const sessionPersistenceBackend = {
      deleteSession: vi.fn(),
      list: vi.fn(),
      loadOne: vi.fn(async ({ projectId, sessionId }: { projectId: string; sessionId: string }) =>
        projectId === session.projectId && sessionId === session.id ? session : undefined
      )
    }
    const { sessionDetailsOwner } = await composeSessionSurfaces({
      modules,
      configRoot: process.cwd(),
      surfaceAdapters: [],
      applicationEvents: { publish },
      settingsService: {
        admitSessionDetailsExecutionTarget: (value: PersistedChatSession) => models.admit(value)
      },
      sessionPersistenceBackend,
      sessionPersistenceCoordinator: {
        mutateSessionDetailsAuthority: async (
          _projectId: string,
          _sessionId: string,
          mutate: (current: PersistedChatSession) => PersistedChatSession | undefined
        ) => {
          const next = mutate(session)
          if (next) session = next
          return next
        }
      },
      specialistService: { subscribe: vi.fn() }
    } as unknown as Parameters<typeof composeSessionSurfaces>[0])
    try {
      await sessionDetailsOwner.start([])
      await sessionDetailsOwner.recoverSession(session)
      await vi.waitFor(() => expect(session.sessionDetailsGeneration?.status).toBe('succeeded'))
      expect(run).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          target: {
            frameworkId,
            providerId,
            model: { kind: 'required', id: 'model' },
            reasoningEffort: 'low'
          }
        })
      )
      expect(session.title).toBe('Proteins')
      expect(session.sessionDetailsGeneration?.requestId).toBe('request')
      expect(session.messages).toHaveLength(1)
      expect(publish).toHaveBeenCalled()
    } finally {
      await sessionDetailsOwner.shutdown()
    }
  }
)

it('starts Session Details without hydrating the startup catalog', async () => {
  let sessionModule:
    | {
        start: () => Promise<void>
        dispose: () => Promise<void>
      }
    | undefined
  const modules: ApplicationModuleBuilder = {
    add: async (dependencies, create) => {
      const module = await create(dependencies)
      if (module.name === 'session-details')
        sessionModule = {
          start: module.start as () => Promise<void>,
          dispose: module.dispose as () => Promise<void>
        }
      return module.capability
    }
  }
  const loadOne = vi.fn()
  persistenceHandlers.loadOne = loadOne
  const { sessionDetailsOwner, sessionPersistenceHandlers } = await composeSessionSurfaces({
    modules,
    configRoot: process.cwd(),
    surfaceAdapters: [],
    applicationEvents: { publish: vi.fn() },
    settingsService: {},
    messageAttributionAuthority: {},
    sessionPersistenceBackend: {
      deleteSession: vi.fn(),
      list: vi.fn(async () => ({ sessions: [] })),
      loadOne: vi.fn()
    },
    sessionPersistenceCoordinator: {
      mutateSessionDetailsAuthority: vi.fn()
    },
    specialistService: { subscribe: vi.fn() },
    composition: { phase: vi.fn() }
  } as unknown as Parameters<typeof composeSessionSurfaces>[0])
  const start = vi.spyOn(sessionDetailsOwner, 'start')
  const recover = vi.spyOn(sessionDetailsOwner, 'recoverSession').mockResolvedValue()
  const opened: PersistedChatSession = {
    id: 'opened',
    projectId: 'project',
    title: 'Opened',
    cwd: '/workspace',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }
  loadOne.mockResolvedValue(opened)
  await sessionModule!.start()
  expect(start).toHaveBeenCalledExactlyOnceWith([])
  await expect(
    sessionPersistenceHandlers.loadOne({ projectId: opened.projectId, sessionId: opened.id })
  ).resolves.toBe(opened)
  expect(recover).not.toHaveBeenCalled()
  await expect(
    sessionPersistenceHandlers.loadOne({
      projectId: opened.projectId,
      sessionId: opened.id,
      recoverSessionDetails: true
    })
  ).resolves.toBe(opened)
  await vi.waitFor(() => expect(recover).toHaveBeenCalledWith(opened))
  await sessionModule!.dispose()
})
