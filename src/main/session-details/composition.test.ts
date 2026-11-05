import { afterEach, expect, it, vi } from 'vitest'
import type { ApplicationModuleBuilder } from '../application-runtime'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { CODEX_SHARED_PROVIDER_ID, CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/settings'
import { RestrictedInferenceRunner } from '../acp/restricted-inference-runner'
import { SessionDetailsModelOwner } from '../settings/session-details-model-owner'
import { composeSessionSurfaces } from '../composition/session-surfaces'

// Keep unrelated surface installation outside this feature's behavioral boundary.
vi.mock('../desktop-surface-declarations', () => ({ createSpecialistElectronSurface: vi.fn() }))
vi.mock('../specialist/application-commands', () => ({ createSpecialistApplicationOwner: vi.fn() }))
vi.mock('../session-persistence/ipc', () => ({
  withSessionDeletionCleanup: (operation: unknown) => operation,
  createSessionPersistenceHandlersWithAttributionAuthority: vi.fn()
}))
vi.mock('../runtime-metadata', () => ({ runtimeMetadata: () => ({ version: 'test' }) }))
afterEach(() => vi.restoreAllMocks())

it.each([
  { type: 'codex-isolated', status: 'queued' },
  { type: 'codex-shared', status: 'queued' },
  { type: 'codex-isolated', status: 'failed' },
  { type: 'codex-shared', status: 'failed' }
] as const)(
  'generates $status Session details through the composed $type subscription runner',
  async ({ type, status }) => {
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
      agentFrameworkId: 'codex',
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
          providers: [{ id: providerId, type, name: 'Codex' }],
          sessionDetailsModel: { mode: 'inherit', reasoningEffort: 'high' }
        })
      },
      providers: {
        resolveRuntimeTarget: vi.fn(() => {
          throw new Error('Subscription must retain its native route.')
        })
      },
      backendResolver: { captureConfiguredSelection: vi.fn() }
    } as unknown as ConstructorParameters<typeof SessionDetailsModelOwner>[0])
    const run = vi.spyOn(RestrictedInferenceRunner.prototype, 'run').mockResolvedValue({
      text: '{"title":"Proteins","description":"Investigate proteins"}',
      stopReason: 'end_turn',
      frameworkId: 'codex',
      model: 'model'
    })
    const modules: ApplicationModuleBuilder = {
      add: async (dependencies, create) => (await create(dependencies)).capability
    }
    const publish = vi.fn()
    const { sessionDetailsOwner } = await composeSessionSurfaces({
      modules,
      configRoot: process.cwd(),
      surfaceAdapters: [],
      applicationEvents: { publish },
      settingsService: {
        admitSessionDetailsExecutionTarget: (value: PersistedChatSession) => models.admit(value)
      },
      sessionPersistenceBackend: {
        deleteSession: vi.fn(),
        loadAll: async () => ({ sessions: [session] })
      },
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
      await sessionDetailsOwner.start()
      await vi.waitFor(() => expect(session.sessionDetailsGeneration?.status).toBe('succeeded'))
      expect(run).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          target: {
            frameworkId: 'codex',
            providerId,
            model: { kind: 'required', id: 'model' },
            reasoningEffort: 'high'
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
