import { beforeEach, expect, it, vi } from 'vitest'
import type { AcpPromptRequest } from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { DelegationSettlementDispatch } from '../delegation/delegation-settlement-wake-owner'
import type { createProductionDelegatedWorkComposition } from '../delegation/production-composition'

const factories = vi.hoisted(() => ({ composition: vi.fn(), framework: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => 'test' }, BrowserWindow: {} }))
vi.mock('../delegation/production-composition', () => ({
  createProductionDelegatedWorkComposition: factories.composition
}))
vi.mock('../delegation/production-framework-runtime', () => ({
  createProductionDelegatedFrameworkRuntime: factories.framework
}))
vi.mock('../acp/artifact-turn-owner', () => ({ ArtifactTurnOwner: class {} }))
vi.mock('../storage-root', () => ({ resolveDataRoot: () => '/data' }))
import { composeDelegation } from './delegation'

type Dependencies = Parameters<typeof composeDelegation>[0]
type Runtime = NonNullable<Dependencies['runtimeRef']['current']>
type CompositionOptions = Parameters<typeof createProductionDelegatedWorkComposition>[0]

beforeEach(() => {
  vi.clearAllMocks()
  factories.composition.mockReturnValue({ root: {} })
})

const fixture = (): {
  dispatch: NonNullable<CompositionOptions['settlementContinuations']>['dispatch']
  request: DelegationSettlementDispatch
  load: ReturnType<typeof vi.fn>
  resolveTarget: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  provider: ReturnType<typeof vi.fn>
  session: PersistedChatSession
} => {
  const session = {
    id: 'session-1',
    projectId: 'project-1',
    cwd: '/saved/workspace',
    permissionProfile: 'ask',
    memoryEnabled: false,
    agentFrameworkId: 'opencode',
    agentBackendId: 'opencode:saved-provider',
    agentModel: 'saved-model',
    providerSessionId: 'saved-provider-session',
    providerContinuityToken: 'saved-continuity',
    conversationGraph: {
      rootFrameId: 'root-1',
      frames: [{ id: 'root-1', activeBranchId: 'branch-1' }],
      branches: [{ id: 'branch-1', createdAt: 1 }]
    }
  } as unknown as PersistedChatSession
  const target = {
    frameworkId: 'opencode',
    providerId: 'saved-provider',
    model: 'saved-model',
    reasoningEffort: 'high'
  }
  const load = vi.fn(async () => session)
  const resolveTarget = vi.fn(async () => target)
  const save = vi.fn(async (updated: PersistedChatSession) => updated)
  const resume = vi.fn(async () => ({ contextReset: true }))
  const provider = vi.fn<(request: AcpPromptRequest) => Promise<{ stopReason: 'end_turn' }>>(
    async () => ({
      stopReason: 'end_turn' as const
    })
  )
  const send: Runtime['sendAppContinuationObserved'] = async (
    request,
    accepted,
    _admission,
    validate,
    prepare
  ) => {
    validate?.()
    await prepare?.()
    validate?.()
    const response = await provider(request)
    accepted()
    return response
  }
  composeDelegation({
    runtimeRef: {
      current: {
        hasLiveSession: () => false,
        resumeSession: resume,
        sendAppContinuationObserved: send
      } as unknown as Runtime
    },
    sessionRepository: { loadSession: load },
    resolveSessionAgentTarget: resolveTarget,
    sessionPersistenceCoordinator: { saveSession: save },
    dataRoot: '/data'
  } as unknown as Dependencies)
  const options = factories.composition.mock.calls.at(-1)![0] as CompositionOptions
  return {
    dispatch: options.settlementContinuations!.dispatch,
    load,
    resolveTarget,
    save,
    resume,
    provider,
    session,
    request: {
      projectId: session.projectId,
      sessionId: session.id,
      rootFrameId: 'root-1',
      rootBranchId: 'branch-1',
      rootBranchRevision: 'branch-1:1',
      originatingPromptId: 'origin-1',
      runtimeSegmentId: 'segment-1',
      batchId: 'batch-1',
      promptId: 'wake-1',
      text: 'settlement update',
      items: [{ frameId: 'child-1', attemptId: 'attempt-1', name: 'Child', status: 'completed' }]
    }
  }
}

it('wires durable settlement restoration to the saved Session target and replay context', async () => {
  const h = fixture()
  await h.dispatch(h.request)
  expect(h.load).toHaveBeenCalledWith('project-1', 'session-1')
  expect(h.resolveTarget).toHaveBeenCalledWith(h.session)
  expect(h.save).toHaveBeenCalledWith(
    expect.objectContaining({
      agentConfiguration: {
        providerId: 'saved-provider',
        model: 'saved-model',
        reasoningEffort: 'high'
      }
    })
  )
  expect(h.resume).toHaveBeenCalledWith({
    sessionId: 'session-1',
    projectId: 'project-1',
    cwd: '/saved/workspace',
    permissionProfile: 'ask',
    memoryEnabled: false,
    previousFrameworkId: 'opencode',
    previousBackendId: 'opencode:saved-provider',
    providerSessionId: 'saved-provider-session',
    providerContinuityToken: 'saved-continuity',
    agentTarget: {
      frameworkId: 'opencode',
      providerId: 'saved-provider',
      model: 'saved-model',
      reasoningEffort: 'high'
    }
  })
  expect(h.provider).toHaveBeenCalledWith(
    expect.objectContaining({
      contextReset: true,
      suppressUserMessage: true,
      provenanceContext: expect.objectContaining({
        promptMessageId: 'origin-1',
        runtimeSegmentId: 'segment-1'
      })
    })
  )
  expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.resume.mock.invocationCallOrder[0])
  expect(h.resume.mock.invocationCallOrder[0]).toBeLessThan(h.provider.mock.invocationCallOrder[0])
})

it.each(['branch', 'archived'] as const)(
  'rejects an invalid %s before restoring or sending settlement',
  async (change) => {
    const h = fixture()
    if (change === 'archived') h.session.archivedAt = 2
    else h.session.conversationGraph!.branches[0].createdAt = 2
    await h.dispatch(h.request)
    expect(h.resolveTarget).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.provider).not.toHaveBeenCalled()
  }
)

it('does not send a settlement prompt when the actual Session restore fails', async () => {
  const h = fixture()
  h.resume.mockRejectedValueOnce(new Error('provider unavailable'))
  await h.dispatch(h.request)
  expect(h.resume).toHaveBeenCalledOnce()
  expect(h.provider).not.toHaveBeenCalled()
})
