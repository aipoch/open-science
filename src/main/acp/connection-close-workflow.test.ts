import { describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../shared/acp'
import { AcpConnectionCloseWorkflow } from './connection-close-workflow'

const snapshot = { status: 'closed' } as AcpStateSnapshot
type TestHarness = {
  workflow: AcpConnectionCloseWorkflow
  actions: string[]
  generation: () => number
  state: Record<string, ReturnType<typeof vi.fn>>
  resources: Record<string, ReturnType<typeof vi.fn>>
  transitions: Record<string, ReturnType<typeof vi.fn>>
  modelChanges: Record<string, ReturnType<typeof vi.fn>>
}

const createWorkflow = (overrides: Record<string, unknown> = {}): TestHarness => {
  const actions: string[] = []
  let generation = 2
  const state = {
    invalidatePendingSessionStartups: vi.fn(() => actions.push('invalidate')),
    disposePermissionContext: vi.fn(() => actions.push('permission')),
    disposeElicitationOwner: vi.fn(() => actions.push('elicitation')),
    clearPendingAppContinuations: vi.fn(() => actions.push('continuations')),
    clearReviewerState: vi.fn(() => actions.push('reviewer')),
    clearPlanInteractions: vi.fn(() => actions.push('plan')),
    settleActivePrompts: vi.fn(() => ['prompt'] as unknown[]),
    supersedeInteractions: vi.fn(() => actions.push('interactions')),
    clearContextUsage: vi.fn(() => actions.push('usage')),
    clearAppliedSessionModels: vi.fn(() => actions.push('models')),
    activeSessionIds: vi.fn(() => ['session']),
    disposeSessionCapabilities: vi.fn(() => actions.push('capabilities')),
    disposeActiveSessions: vi.fn(() => actions.push('sessions')),
    detachSessionConnections: vi.fn(() => actions.push('detach')),
    clearPromptContent: vi.fn(() => actions.push('prompt-content')),
    clearHandoffContinuity: vi.fn(() => actions.push('handoff')),
    clearSessionProjection: vi.fn(() => actions.push('projection-clear')),
    disposeSessionProjection: vi.fn(() => actions.push('projection-dispose')),
    clearHttpRoutes: vi.fn(() => actions.push('routes')),
    selectSession: vi.fn(() => actions.push('select')),
    publishInterruptedPromptFailures: vi.fn(() => actions.push('prompt-failures')),
    setStatus: vi.fn((status: AcpStateSnapshot['status']) => actions.push(status)),
    transitionStatus: vi.fn((status: AcpStateSnapshot['status']) => actions.push(status)),
    emitState: vi.fn(() => actions.push('emit')),
    hasContextUsage: vi.fn(() => true)
  }
  const resources = {
    supersede: vi.fn(() => {
      generation += 1
      return generation
    }),
    restorePublished: vi.fn(),
    teardown: vi.fn(async () => undefined),
    closeMcp: vi.fn(async () => undefined),
    cleanupUnexpectedClose: vi.fn(),
    shutdownSynchronously: vi.fn((onSuperseded: () => void) => {
      generation += 1
      onSuperseded()
    }),
    beginAwaitableShutdown: vi.fn(() => ({ finish: async () => ({ reaped: true }) }))
  }
  const transitions = {
    settleTeardown: vi.fn(async <T>(teardown: () => Promise<T>) => teardown()),
    resetReconnect: vi.fn(),
    activityChanged: vi.fn(),
    requestProviderReconnect: vi.fn(async () => {
      actions.push('provider-reconnect')
    }),
    requestRetirement: vi.fn(async () => {
      actions.push('retirement')
    })
  }
  const modelChanges = {
    cancel: vi.fn(() => actions.push('model-cancel')),
    cancelAndDrain: vi.fn(async () => {
      actions.push('model-drain')
    })
  }
  const workflow = new AcpConnectionCloseWorkflow({
    currentGeneration: () => generation,
    currentStatus: () => 'connected',
    getSnapshot: () => snapshot,
    transitions,
    resources,
    modelChanges,
    backendGeneration: {
      supersede: vi.fn((throughEpoch: number) => actions.push(`backend:${throughEpoch}`))
    },
    state,
    reportFailure: vi.fn(),
    ...overrides
  } as never)
  return {
    workflow,
    actions,
    generation: () => generation,
    state,
    resources,
    transitions,
    modelChanges
  }
}

describe('AcpConnectionCloseWorkflow', () => {
  it('coordinates expected teardown while preserving owner ordering', async () => {
    const { workflow, actions, resources, transitions } = createWorkflow()

    await expect(workflow.disconnect()).resolves.toBe(snapshot)

    expect(transitions.settleTeardown).toHaveBeenCalledOnce()
    expect(resources.supersede).toHaveBeenCalledOnce()
    expect(resources.teardown).toHaveBeenCalledOnce()
    expect(resources.closeMcp).toHaveBeenCalledOnce()
    expect(actions).toEqual([
      'model-cancel',
      'invalidate',
      'permission',
      'elicitation',
      'continuations',
      'reviewer',
      'plan',
      'interactions',
      'usage',
      'models',
      'capabilities',
      'sessions',
      'detach',
      'prompt-content',
      'projection-clear',
      'routes',
      'select',
      'closed',
      'backend:2'
    ])
  })

  it('cleans an unexpected close once, reports interrupted prompts, then reevaluates intents', () => {
    const { workflow, actions, resources, transitions, state } = createWorkflow()

    workflow.handleUnexpectedClose()

    expect(resources.cleanupUnexpectedClose).toHaveBeenCalledOnce()
    expect(state.settleActivePrompts).toHaveBeenCalledOnce()
    expect(state.publishInterruptedPromptFailures).toHaveBeenCalledWith(['prompt'])
    expect(transitions.resetReconnect).toHaveBeenCalledOnce()
    expect(transitions.activityChanged).toHaveBeenCalledOnce()
    expect(actions).toEqual([
      'model-cancel',
      'invalidate',
      'permission',
      'elicitation',
      'continuations',
      'reviewer',
      'plan',
      'backend:2',
      'capabilities',
      'detach',
      'prompt-content',
      'handoff',
      'projection-dispose',
      'usage',
      'routes',
      'select',
      'interactions',
      'closed',
      'prompt-failures'
    ])
  })

  it('keeps quit shutdown awaitable and combines candidate reap results', async () => {
    const { workflow, resources, state } = createWorkflow()
    resources.beginAwaitableShutdown.mockReturnValue({
      finish: async () => ({ reaped: false })
    })

    workflow.recordProcessTreeReaped(false)
    await expect(workflow.shutdownForQuit()).resolves.toEqual({ reaped: false })

    expect(resources.beginAwaitableShutdown).toHaveBeenCalledWith(true)
    expect(state.clearPlanInteractions).toHaveBeenCalledOnce()
    expect(state.clearSessionProjection).toHaveBeenCalledOnce()
  })

  it('clears Plan interactions during synchronous shutdown', () => {
    const { workflow, state } = createWorkflow()

    workflow.shutdown()

    expect(state.clearPlanInteractions).toHaveBeenCalledOnce()
  })

  it('clears usage before deferring provider reconnect and delegates intent ownership', async () => {
    const { workflow, actions, state, transitions, modelChanges } = createWorkflow()

    await workflow.requestProviderReconnect()

    expect(modelChanges.cancelAndDrain).toHaveBeenCalledOnce()
    expect(state.clearContextUsage).toHaveBeenCalledOnce()
    expect(state.clearAppliedSessionModels).toHaveBeenCalledOnce()
    expect(state.emitState).toHaveBeenCalledOnce()
    expect(transitions.requestProviderReconnect).toHaveBeenCalledOnce()
    expect(actions).toEqual(['model-drain', 'usage', 'models', 'emit', 'provider-reconnect'])
  })

  it('drains model changes before delegating retirement intent', async () => {
    const { workflow, actions, transitions, modelChanges } = createWorkflow()

    await workflow.requestRetirement()

    expect(modelChanges.cancelAndDrain).toHaveBeenCalledOnce()
    expect(transitions.requestRetirement).toHaveBeenCalledOnce()
    expect(actions).toEqual(['model-drain', 'retirement'])
  })
})
