import type { ActiveSession, ClientConnection, SessionConfigOption } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import type { AgentModelChangeTarget } from '../agent-framework'
import { claudeCodeFramework } from '../agent-framework'
import type {
  AcpBackendGenerationOwner,
  AcpBackendGenerationView
} from './backend-generation-owner'
import type { AcpConnectionResourceOwner } from './connection-resource-owner'
import type { ContextUsageTracker } from './context-usage-tracker'
import { AcpModelChangeWorkflow } from './model-change-workflow'
import type { AcpSessionConfigurator } from './session-configurator'
import { AcpSessionRegistry } from './session-registry'

const permissionProfile: SessionPermissionProfileState = {
  selectedProfile: 'ask',
  effectiveProfile: 'ask',
  currentModeId: 'default',
  availableModeIds: ['default'],
  fullAccessAvailable: false
}

const modelOption = (currentValue = 'model-a'): SessionConfigOption =>
  ({
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue,
    options: ['model-a', 'model-b', 'model-c'].map((value) => ({ value, name: value }))
  }) as SessionConfigOption

const target = (
  model: string,
  overrides: Partial<AgentModelChangeTarget> = {}
): AgentModelChangeTarget => ({
  frameworkId: 'claude-code',
  backendId: 'claude-code:provider',
  route: 'claude-anthropic',
  model,
  sessionModel: model,
  sessionModelRequired: false,
  reasoningEffort: 'default',
  supportsImageInput: false,
  ...overrides
})

type WorkflowHarness = {
  workflow: AcpModelChangeWorkflow
  request: ReturnType<typeof vi.fn>
  requestReconnect: ReturnType<typeof vi.fn>
  recoverFailedReconnect: ReturnType<typeof vi.fn>
  reportReconnectFailure: ReturnType<typeof vi.fn>
  updateModel: ReturnType<typeof vi.fn>
  updateReasoningEffort: ReturnType<typeof vi.fn>
  updateAggregateModel: ReturnType<typeof vi.fn>
  setProviderTransportTarget: ReturnType<typeof vi.fn>
  setAnthropicBridgeTarget: ReturnType<typeof vi.fn>
  setBridgeReasoningEffort: ReturnType<typeof vi.fn>
  applyLiveEffort: ReturnType<typeof vi.fn>
  clearContext: ReturnType<typeof vi.fn>
  beginContext: ReturnType<typeof vi.fn>
  emitState: ReturnType<typeof vi.fn>
  setBusy: (value: boolean) => void
  setConnected: (value: boolean) => void
  setProviderReconnectPending: (value: boolean) => void
  setSupportsImageInput: (value: boolean) => void
  setReplayableImageHistory: (value: boolean) => void
}

const createHarness = (): WorkflowHarness => {
  let busy = false
  let connected = true
  let providerReconnectPending = false
  let replayableImageHistory = true
  let backend: AcpBackendGenerationView = {
    framework: claudeCodeFramework,
    backendId: 'claude-code:provider',
    modelRoute: 'claude-anthropic',
    session: { model: 'model-a', modelRequired: false },
    prompt: { systemPromptAppends: [] },
    context: { model: 'model-a', supportsImageInput: false },
    adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false }
  }
  let options = [modelOption()]
  const request = vi.fn(async (_method: unknown, params: unknown) => {
    const value = (params as { value: string }).value
    options = [modelOption(value)]
    return { configOptions: options }
  })
  const connection = { agent: { request } } as unknown as ClientConnection
  const session = {
    sessionId: 'provider-session',
    newSessionResponse: { configOptions: options },
    dispose: vi.fn()
  } as unknown as ActiveSession
  const registry = new AcpSessionRegistry()
  const reserved = registry.reserve({ sessionIds: ['app-session', session.sessionId] })
  if (reserved.collision) throw reserved.collision
  const entry = registry.publish(reserved.reservation, 'app-session', {
    session,
    cwd: '/workspace',
    projectId: 'project-a',
    frameworkId: 'claude-code',
    backendId: backend.backendId,
    permissionProfile,
    appliedModel: 'model-a',
    configOptions: options
  })
  reserved.reservation.release()
  const updateAggregateModel = vi.spyOn(entry.aggregate, 'updateModel')

  const updateModel = vi.fn((next: AgentModelChangeTarget) => {
    backend = {
      ...backend,
      backendId: next.backendId,
      modelRoute: next.route,
      session: {
        ...backend.session,
        model: next.sessionModel,
        modelRequired: next.sessionModelRequired,
        ...(next.reasoningEffort === 'default' ? {} : { effort: next.reasoningEffort })
      },
      context: {
        model: next.model,
        ...(next.contextWindow ? { window: next.contextWindow } : {}),
        supportsImageInput: next.supportsImageInput
      }
    }
    return backend
  })
  const updateReasoningEffort = vi.fn((effort: 'default' | 'low' | 'medium' | 'high' | 'max') => {
    backend = {
      ...backend,
      session: {
        ...backend.session,
        ...(effort === 'default' ? {} : { effort })
      }
    }
    return backend
  })
  const backendGeneration = {
    get current() {
      return backend
    },
    updateModel,
    updateReasoningEffort
  } as Pick<AcpBackendGenerationOwner, 'current' | 'updateModel' | 'updateReasoningEffort'>

  const setProviderTransportTarget = vi.fn(() => true)
  const setAnthropicBridgeTarget = vi.fn(() => true)
  const setBridgeReasoningEffort = vi.fn()
  const connectionResources = {
    epoch: 1,
    get connection() {
      return connected ? connection : undefined
    },
    get isShuttingDown() {
      return false
    },
    get anthropicBridgeAvailable() {
      return false
    },
    get providerTransportAvailable() {
      return false
    },
    assertCurrentConnection: vi.fn(),
    setProviderTransportTarget,
    setAnthropicBridgeTarget,
    setBridgeModelTarget: vi.fn(() => true),
    setBridgeReasoningEffort
  } as Pick<
    AcpConnectionResourceOwner,
    | 'epoch'
    | 'connection'
    | 'isShuttingDown'
    | 'anthropicBridgeAvailable'
    | 'providerTransportAvailable'
    | 'assertCurrentConnection'
    | 'setProviderTransportTarget'
    | 'setAnthropicBridgeTarget'
    | 'setBridgeModelTarget'
    | 'setBridgeReasoningEffort'
  >

  const applyLiveEffort = vi.fn(async () => ({ reconnectRequired: false }))
  const clearContext = vi.fn()
  const beginContext = vi.fn()
  const emitState = vi.fn()
  const requestReconnect = vi.fn(async () => undefined)
  const recoverFailedReconnect = vi.fn()
  const reportReconnectFailure = vi.fn()
  const workflow = new AcpModelChangeWorkflow({
    backendGeneration,
    connectionResources,
    registry,
    configurator: { applyLiveEffort } as Pick<AcpSessionConfigurator, 'applyLiveEffort'>,
    contextUsage: {
      clear: clearContext,
      beginSession: beginContext
    } as Pick<ContextUsageTracker, 'clear' | 'beginSession'>,
    currentStatus: () => (connected ? 'connected' : 'closed'),
    providerReconnectPending: () => providerReconnectPending,
    isGenerationBusy: () => busy,
    contextEstimateInput: () => ({ frameworkId: 'claude-code', model: backend.context.model }),
    hasReplayableImageHistory: vi.fn(async () => replayableImageHistory),
    emitState,
    requestReconnect,
    recoverFailedReconnect,
    reportReconnectFailure,
    diagnosticContext: () => ({})
  })

  return {
    workflow,
    request,
    requestReconnect,
    recoverFailedReconnect,
    reportReconnectFailure,
    updateModel,
    updateReasoningEffort,
    updateAggregateModel,
    setProviderTransportTarget,
    setAnthropicBridgeTarget,
    setBridgeReasoningEffort,
    applyLiveEffort,
    clearContext,
    beginContext,
    emitState,
    setBusy: (value) => {
      busy = value
    },
    setConnected: (value) => {
      connected = value
    },
    setProviderReconnectPending: (value) => {
      providerReconnectPending = value
    },
    setSupportsImageInput: (value) => {
      backend = { ...backend, context: { ...backend.context, supportsImageInput: value } }
    },
    setReplayableImageHistory: (value) => {
      replayableImageHistory = value
    }
  }
}

describe('ACP model-change workflow', () => {
  it('rejects an incompatible target without arming admission', async () => {
    const harness = createHarness()
    harness.setConnected(false)

    await expect(harness.workflow.apply(target('model-b'))).resolves.toBe(false)

    expect(harness.workflow.barrier).toBeUndefined()
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('keeps only the latest target while the generation is busy', async () => {
    const harness = createHarness()
    harness.setBusy(true)

    await harness.workflow.apply(target('model-b'))
    await harness.workflow.apply(target('model-c'))
    expect(harness.request).not.toHaveBeenCalled()
    const barrier = harness.workflow.barrier
    expect(barrier).toBeDefined()

    harness.setBusy(false)
    harness.workflow.activityChanged()
    await barrier

    expect(harness.request).toHaveBeenCalledOnce()
    expect(harness.request.mock.calls[0]?.[1]).toMatchObject({ value: 'model-c' })
    expect(harness.updateModel).toHaveBeenCalledWith(target('model-c'))
    expect(harness.updateAggregateModel).toHaveBeenCalledWith(
      'model-c',
      expect.any(Array),
      'claude-code:provider'
    )
  })

  it('cancels a pending target when the current target is selected again', async () => {
    const harness = createHarness()
    harness.setBusy(true)
    await harness.workflow.apply(target('model-b'))
    harness.setBusy(false)

    await expect(harness.workflow.apply(target('model-a'))).resolves.toBe(true)

    expect(harness.workflow.barrier).toBeUndefined()
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('commits model and context facts only after every live Session is configured', async () => {
    const harness = createHarness()

    await expect(harness.workflow.apply(target('model-b'))).resolves.toBe(true)

    expect(harness.updateModel).toHaveBeenCalledOnce()
    expect(harness.clearContext).toHaveBeenCalledOnce()
    expect(harness.beginContext).toHaveBeenCalledWith(
      'app-session',
      expect.objectContaining({ model: 'model-b' })
    )
    expect(harness.emitState).toHaveBeenCalledOnce()
  })

  it('reconnects when the current generation lacks a projected provider target', async () => {
    const harness = createHarness()
    harness.setProviderTransportTarget.mockReturnValue(false)

    await expect(
      harness.workflow.apply(target('model-b', { providerTransportTargetId: 'provider/model-b' }))
    ).resolves.toBe(true)

    expect(harness.setProviderTransportTarget).toHaveBeenCalledWith('provider/model-b')
    expect(harness.requestReconnect).toHaveBeenCalledOnce()
    expect(harness.updateModel).not.toHaveBeenCalled()
  })

  it('reconnects when the current generation lacks a projected Anthropic target', async () => {
    const harness = createHarness()
    harness.setAnthropicBridgeTarget.mockReturnValue(false)

    await expect(
      harness.workflow.apply(target('model-b', { anthropicBridgeTargetId: 'provider/model-b' }))
    ).resolves.toBe(true)

    expect(harness.setAnthropicBridgeTarget).toHaveBeenCalledWith('provider/model-b')
    expect(harness.requestReconnect).toHaveBeenCalledOnce()
    expect(harness.updateModel).not.toHaveBeenCalled()
  })

  it('reconnects instead of committing an image downgrade with opaque provider history', async () => {
    const harness = createHarness()
    harness.setSupportsImageInput(true)

    await expect(
      harness.workflow.apply(target('model-b', { supportsImageInput: false }))
    ).resolves.toBe(true)

    expect(harness.requestReconnect).toHaveBeenCalledOnce()
    expect(harness.updateModel).not.toHaveBeenCalled()
  })

  it('reconnects when an image-capable model replaces a text-only model', async () => {
    const harness = createHarness()

    await expect(
      harness.workflow.apply(target('model-b', { supportsImageInput: true }))
    ).resolves.toBe(true)

    expect(harness.requestReconnect).toHaveBeenCalledOnce()
    expect(harness.updateModel).not.toHaveBeenCalled()
  })

  it('applies a capability-boundary model change live when history has no images', async () => {
    const harness = createHarness()
    harness.setSupportsImageInput(true)
    harness.setReplayableImageHistory(false)

    await expect(
      harness.workflow.apply(target('model-b', { supportsImageInput: false }))
    ).resolves.toBe(true)

    expect(harness.requestReconnect).not.toHaveBeenCalled()
    expect(harness.updateModel).toHaveBeenCalledOnce()
  })

  it('recovers a failed reconnect before releasing admission', async () => {
    const harness = createHarness()
    const failure = new Error('reconnect failed')
    harness.setSupportsImageInput(true)
    harness.requestReconnect.mockRejectedValue(failure)

    await expect(
      harness.workflow.apply(target('model-b', { supportsImageInput: false }))
    ).resolves.toBe(true)

    expect(harness.reportReconnectFailure).toHaveBeenCalledWith(failure)
    expect(harness.recoverFailedReconnect).toHaveBeenCalledOnce()
    expect(harness.recoverFailedReconnect).toHaveBeenCalledWith(1)
    expect(harness.workflow.barrier).toBeUndefined()
  })

  it('applies effort through the same model barrier and live configurator', async () => {
    const harness = createHarness()

    await expect(harness.workflow.applyReasoningEffort('high')).resolves.toBe(true)

    expect(harness.updateReasoningEffort).toHaveBeenCalledWith('high')
    expect(harness.setBridgeReasoningEffort).toHaveBeenCalledWith('high')
    expect(harness.applyLiveEffort).toHaveBeenCalledOnce()
  })

  it('does not leak effort into the old generation while reconnect is pending', async () => {
    const harness = createHarness()
    harness.setProviderReconnectPending(true)

    await expect(harness.workflow.applyReasoningEffort('high')).resolves.toBe(false)

    expect(harness.updateReasoningEffort).not.toHaveBeenCalled()
    expect(harness.applyLiveEffort).not.toHaveBeenCalled()
  })
})
