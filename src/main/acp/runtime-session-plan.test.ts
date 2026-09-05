import { describe, expect, it, vi } from 'vitest'

import { PlanCommandError, type ActivePlanProjection } from '../../shared/session-plan/contract'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { AcpRuntime } from './runtime'
import { composeAcpRuntimePlanWorkflow } from './runtime-plan-composition'

const projection = (
  artifactVersionId: string,
  revision = 1,
  originatingPromptMessageId: string | null = 'interaction-1'
): ActivePlanProjection => ({
  artifactId: `artifact-${artifactVersionId}`,
  artifactVersionId,
  artifactChecksum: 'a'.repeat(64),
  ...(originatingPromptMessageId ? { originatingPromptMessageId } : {}),
  revision,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  document: {
    schema_version: 1,
    task_summary: 'Analyze one dataset',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Analysis result'],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { 'Analyze the data': { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
})

type PlanServiceMock = Record<
  'generate' | 'respond' | 'getProjection' | 'updateStepStatus',
  ReturnType<typeof vi.fn>
>

type RuntimeHarness = Readonly<{
  runtime: AcpRuntime
  service: PlanServiceMock
  interactions: SessionPlanInteractionOwner
  setCurrentInteraction: (interaction: { sequence: number; promptMessageId: string }) => void
  updateStepStatus: ReturnType<typeof vi.fn>
}>

const createRuntimeHarness = (options: {
  onEvent?: (event?: unknown) => void
  activeProjection?: ActivePlanProjection
  durableMessageIds?: string[]
  cancelNotify?: () => Promise<void>
}): RuntimeHarness => {
  const generated = projection('version-1')
  const approved = { ...generated, approval: 'approved' as const, lifecycle: 'approved' as const }
  let currentProjection = options.activeProjection ?? generated
  const updateStepStatus = vi.fn(
    async (input: {
      authorizeUpdate?: (projection: ActivePlanProjection) => void | Promise<void>
    }) => {
      await input.authorizeUpdate?.(currentProjection)
      return { projection: approved, changed: true }
    }
  )
  const interactions = new SessionPlanInteractionOwner()
  const service = {
    generate: vi.fn(async () => ({ projection: generated, pauseInteraction: true as const })),
    respond: vi.fn(async (input: { feedback?: string; decision?: 'approved' | 'rejected' }) => {
      if (input.feedback) {
        return {
          kind: 'feedback' as const,
          routeToInteractionId: 'interaction-1',
          artifactVersionId: generated.artifactVersionId,
          text: input.feedback,
          deliveryCommandId: 'delivery-1',
          message: {
            id: 'message-1',
            role: 'user' as const,
            content: input.feedback,
            status: 'complete' as const,
            eventIds: [],
            responseToMessageId: 'interaction-1',
            createdAt: 10,
            updatedAt: 10
          }
        }
      }
      currentProjection =
        input.decision === 'rejected'
          ? { ...generated, approval: 'rejected' as const, lifecycle: 'rejected' as const }
          : approved
      return { projection: currentProjection, changed: true, deliveryCommandId: 'delivery-1' }
    }),
    getProjection: vi.fn(
      async (
        _projectId: string,
        _sessionId: string,
        projectionOptions?: { interactionIsLive?: boolean }
      ) => {
        const current = currentProjection
        return projectionOptions?.interactionIsLive === false && current.lifecycle === 'in_progress'
          ? { ...current, lifecycle: 'interrupted' as const }
          : current
      }
    ),
    updateStepStatus
  }
  let currentInteraction = {
    kind: 'prompt' as const,
    sessionId: 'session-1',
    sequence: 7,
    turnToken: 'turn-token-7',
    promptMessageId: 'interaction-1'
  }
  const sessionInteractions = {
    snapshot: () => [{ kind: 'prompt', sessionId: 'session-1' }],
    current: () => currentInteraction,
    cancelPrompt: vi.fn(
      async ({ notify, onAccepted }: { notify: () => Promise<void>; onAccepted: () => void }) => {
        await notify()
        onAccepted()
      }
    )
  }
  const planSessions = {
    containsMessageOnActiveBranch: vi.fn(
      async (_projectId: string, _sessionId: string, messageId: string) =>
        (options.durableMessageIds ?? ['interaction-1']).includes(messageId)
    )
  }
  const sessionPlanWorkflow = composeAcpRuntimePlanWorkflow(
    { plan: { sessions: planSessions } } as unknown as Parameters<
      typeof composeAcpRuntimePlanWorkflow
    >[0],
    {
      planService: service,
      planInteractions: interactions,
      sessionInteractions,
      artifactTurns: {
        handleForExecution: () => 'artifact-handle',
        snapshot: () => ({ promptMessageId: 'interaction-1' })
      }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
    {
      publication: { pushEvent: (event: unknown) => options.onEvent?.(event) }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2],
    {
      deliveries: {
        accept: vi.fn(async () => true),
        begin: vi.fn(async () => true),
        clear: vi.fn(async () => true),
        rearmUnaccepted: vi.fn(async () => true)
      }
    }
  )
  const target = Object.create(AcpRuntime.prototype) as Record<string, unknown>
  Object.assign(target, {
    planService: service,
    planInteractions: interactions,
    sessionInteractions,
    connectionResources: {
      connection: { agent: { notify: vi.fn(options.cancelNotify ?? (async () => undefined)) } }
    },
    sessionRegistry: {
      lookup: () => ({ attachment: { session: { sessionId: 'provider-session-1' } } })
    },
    sessionPlanWorkflow,
    appContinuations: {
      get: vi.fn(() => undefined),
      delete: vi.fn(() => false)
    },
    planDeliveryClaimRetries: new Map(),
    artifactTurns: {
      handleForExecution: () => 'artifact-handle',
      snapshot: () => ({ promptMessageId: 'interaction-1' })
    },
    sessionDeletion: {
      delete: vi.fn(async () => ({ status: 'closed' }))
    },
    permissionContext: { cancelForSession: vi.fn() },
    elicitationOwner: { cancelForSession: vi.fn() },
    publication: { emitState: vi.fn() },
    callbacks: { onEvent: options.onEvent },
    pushEvent: (event: unknown) => options.onEvent?.(event),
    getSnapshot: () => ({ status: 'connected' }),
    resolveSessionProjectId: () => 'project-1'
  })
  return {
    runtime: target as unknown as AcpRuntime,
    service,
    interactions,
    setCurrentInteraction: ({ sequence, promptMessageId }) => {
      currentInteraction = { ...currentInteraction, sequence, promptMessageId }
    },
    updateStepStatus
  }
}

describe('AcpRuntime Session Plan seam', () => {
  it('blocks generate_plan until approval and then resumes the same interaction', async () => {
    const { runtime, service } = createRuntimeHarness({
      onEvent: () => {
        throw new Error('renderer unavailable')
      }
    })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    let settled = false
    void pending.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        expectedRevision: 1,
        decision: 'approved'
      })
    ).resolves.toMatchObject({ changed: true })
    await expect(pending).resolves.toMatchObject({ changed: true })
    expect(service.respond).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'approved', interactionIsLive: true })
    )
  })

  it('rejects duplicate generation before writing a replacement Plan', async () => {
    const { runtime, service, interactions } = createRuntimeHarness({})
    let markGenerateStarted!: () => void
    let finishGenerate!: () => void
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve
    })
    const generateGate = new Promise<void>((resolve) => {
      finishGenerate = resolve
    })
    service.generate.mockImplementation(async () => {
      markGenerateStarted()
      await generateGate
      return { projection: projection('version-1'), pauseInteraction: true as const }
    })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await generateStarted
    const duplicate = runtime
      .callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
      .catch((error) => error)
    await Promise.resolve()

    expect(service.generate).toHaveBeenCalledOnce()
    await expect(duplicate).resolves.toMatchObject({
      message: 'A Session Plan is already awaiting approval.'
    })
    finishGenerate()
    await vi.waitFor(() => {
      expect(interactions.approvalInteractionIdFor('session-1')).toBe('interaction-1')
    })

    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      decision: 'approved'
    })
    await expect(pending).resolves.toMatchObject({ changed: true })
  })

  it('releases generation admission when durable Plan creation fails', async () => {
    const { runtime, service, interactions } = createRuntimeHarness({})
    service.generate.mockRejectedValueOnce(new Error('artifact write failed'))
    service.getProjection.mockResolvedValueOnce(null)

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
    ).rejects.toThrow('artifact write failed')

    const retry = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await vi.waitFor(() => {
      expect(interactions.approvalInteractionIdFor('session-1')).toBe('interaction-1')
    })
    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      decision: 'approved'
    })
    await expect(retry).resolves.toMatchObject({ changed: true })
  })

  it('does not park a Plan after its generating interaction is cancelled', async () => {
    const { runtime, service, interactions } = createRuntimeHarness({})
    let markGenerateStarted!: () => void
    let finishGenerate!: () => void
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve
    })
    const generateGate = new Promise<void>((resolve) => {
      finishGenerate = resolve
    })
    service.generate.mockImplementationOnce(async () => {
      markGenerateStarted()
      await generateGate
      return { projection: projection('version-1'), pauseInteraction: true as const }
    })
    const cancelled = runtime
      .callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
      .catch((error) => error)
    await generateStarted

    await runtime.cancelPrompt({ sessionId: 'session-1' })
    finishGenerate()

    await expect(cancelled).resolves.toMatchObject({
      message: 'The Session Plan approval reservation is no longer available.'
    })
    expect(interactions.approvalInteractionIdFor('session-1')).toBeUndefined()

    const retry = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await vi.waitFor(() => {
      expect(interactions.approvalInteractionIdFor('session-1')).toBe('interaction-1')
    })
    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      decision: 'approved'
    })
    await expect(retry).resolves.toMatchObject({ changed: true })
  })

  it('does not cancel a successor approval when the older cancel acknowledgement arrives late', async () => {
    let markNotifyStarted!: () => void
    let finishNotify!: () => void
    const notifyStarted = new Promise<void>((resolve) => {
      markNotifyStarted = resolve
    })
    const notifyGate = new Promise<void>((resolve) => {
      finishNotify = resolve
    })
    const { runtime, interactions, setCurrentInteraction } = createRuntimeHarness({
      cancelNotify: async () => {
        markNotifyStarted()
        await notifyGate
      }
    })
    const oldApproval = interactions
      .parkApproval('session-1', 'interaction-1')
      .catch((error) => error)
    const cancellation = runtime.cancelPrompt({ sessionId: 'session-1' })
    await notifyStarted

    interactions.rejectApproval('session-1', 'older interaction ended')
    await expect(oldApproval).resolves.toMatchObject({ message: 'older interaction ended' })
    setCurrentInteraction({ sequence: 8, promptMessageId: 'interaction-2' })
    const successorApproval = interactions.parkApproval('session-1', 'interaction-2')
    finishNotify()
    await cancellation

    expect(interactions.approvalInteractionIdFor('session-1')).toBe('interaction-2')
    interactions.resolveApproval('session-1', { decision: 'approved' })
    await expect(successorApproval).resolves.toEqual({ decision: 'approved' })
  })

  it('updates an approved Plan from an ordinary Attempt without live interaction affinity', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-1', 4),
        approval: 'approved',
        lifecycle: 'approved'
      }
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).resolves.toMatchObject({ changed: true })
    expect(updateStepStatus).toHaveBeenCalledOnce()
  })

  it('rejects an expected Artifact Version after a replacement became active', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-2', 4),
        approval: 'approved',
        lifecycle: 'approved'
      }
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: {
          title: 'Analyze the data',
          status: 'completed',
          expectedArtifactVersionId: 'version-1'
        }
      })
    ).rejects.toMatchObject({ code: 'stale-plan' })
    expect(updateStepStatus).toHaveBeenCalledOnce()
  })

  it('rejects an MCP Plan decision when the Plan originated on a sibling Message Branch', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: projection('version-2', 4, 'sibling-message'),
      durableMessageIds: ['parent-message', 'interaction-1']
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(service.respond).not.toHaveBeenCalled()
  })

  it('rejects an MCP Plan decision when a legacy Plan has no originating Message', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: projection('legacy-version', 1, null)
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(service.respond).not.toHaveBeenCalled()
  })

  it('rejects a renderer Plan decision when the Plan originated on a sibling Message Branch', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: projection('version-2', 4, 'sibling-message'),
      durableMessageIds: ['parent-message', 'interaction-1']
    })

    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'version-2',
        expectedRevision: 4,
        decision: 'approved'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(service.respond).not.toHaveBeenCalled()
  })

  it('rejects renderer Plan feedback when the Plan originated on a sibling Message Branch', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: projection('version-2', 4, 'sibling-message'),
      durableMessageIds: ['parent-message', 'interaction-1']
    })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    void pending.catch(() => undefined)
    await Promise.resolve()

    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        feedback: 'Use the sibling Plan.'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(service.respond).not.toHaveBeenCalled()
  })

  it('updates an approved Plan without a special wakeup Attempt', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-1', 4),
        approval: 'approved',
        lifecycle: 'approved'
      }
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).resolves.toMatchObject({ changed: true })
    expect(updateStepStatus).toHaveBeenCalledOnce()
  })

  it('updates an approved Plan after the active interaction changes', async () => {
    const { runtime, setCurrentInteraction, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-2', 4),
        approval: 'approved',
        lifecycle: 'approved'
      }
    })
    setCurrentInteraction({ sequence: 8, promptMessageId: 'interaction-2' })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).resolves.toMatchObject({ changed: true })
    expect(updateStepStatus).toHaveBeenCalledOnce()
  })

  it('rejects an Agent decision whose authorization is revoked while the response is pending', async () => {
    const { runtime, interactions, service, setCurrentInteraction } = createRuntimeHarness({})
    interactions.authorizeAgentDecision({
      sessionId: 'session-1',
      interactionSequence: 7,
      artifactVersionId: 'version-1'
    })
    let markRespondStarted!: () => void
    let finishRespond!: () => void
    const respondStarted = new Promise<void>((resolve) => {
      markRespondStarted = resolve
    })
    const respondGate = new Promise<void>((resolve) => {
      finishRespond = resolve
    })
    let decisionPersisted = false
    service.respond.mockImplementationOnce(async (input) => {
      markRespondStarted()
      await respondGate
      if (input.beforeDecisionCommit && !input.beforeDecisionCommit()) {
        throw new PlanCommandError('interaction-mismatch', 'Decision authorization was revoked.')
      }
      decisionPersisted = true
      return {
        projection: {
          ...projection('version-1'),
          approval: 'approved' as const,
          lifecycle: 'approved' as const
        },
        changed: true
      }
    })

    const approved = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'approve'
    })
    await respondStarted
    interactions.releaseAgentDecisionAuthorization('session-1', 7)
    setCurrentInteraction({ sequence: 8, promptMessageId: 'interaction-2' })
    finishRespond()

    await expect(approved).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(decisionPersisted).toBe(false)
  })

  it('restores decision authorization after persistence fails so the same interaction can retry', async () => {
    const { runtime, interactions, service } = createRuntimeHarness({})
    const authorization = {
      sessionId: 'session-1',
      interactionSequence: 7,
      artifactVersionId: 'version-1'
    }
    interactions.authorizeAgentDecision(authorization)
    let attempts = 0
    service.respond.mockImplementation(async (input) => {
      expect(input.beforeDecisionCommit?.()).toBe(true)
      attempts += 1
      if (attempts === 1) {
        throw new PlanCommandError('revision-conflict', 'The Plan revision changed concurrently.')
      }
      return {
        projection: {
          ...projection('version-1'),
          approval: 'approved' as const,
          lifecycle: 'approved' as const
        },
        changed: true
      }
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(interactions.isAgentDecisionAuthorized(authorization)).toBe(true)

    service.getProjection.mockResolvedValueOnce(projection('version-1')).mockResolvedValueOnce({
      ...projection('version-1'),
      approval: 'approved',
      lifecycle: 'approved'
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).resolves.toMatchObject({ projection: { approval: 'approved' } })
    expect(interactions.isAgentDecisionAuthorized(authorization)).toBe(false)
    expect(attempts).toBe(2)
  })

  it('clears decision authorization after an idempotent Agent approval', async () => {
    const { runtime, interactions, service } = createRuntimeHarness({})
    const authorization = {
      sessionId: 'session-1',
      interactionSequence: 7,
      artifactVersionId: 'version-1'
    }
    interactions.authorizeAgentDecision(authorization)
    service.respond.mockImplementationOnce(async (input) => {
      expect(input.beforeDecisionCommit).toBeTypeOf('function')
      return {
        projection: {
          ...projection('version-1'),
          approval: 'approved' as const,
          lifecycle: 'approved' as const
        },
        changed: false
      }
    })

    await runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'approve'
    })

    expect(interactions.isAgentDecisionAuthorized(authorization)).toBe(false)
  })

  it('routes feedback as a visible user Message and resumes the blocked interaction', async () => {
    const onEvent = vi.fn()
    const { runtime } = createRuntimeHarness({ onEvent })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await Promise.resolve()
    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        feedback: 'Split the analysis by cohort.'
      })
    ).resolves.toMatchObject({ kind: 'feedback' })
    await expect(pending).resolves.toMatchObject({
      kind: 'feedback',
      text: 'Split the analysis by cohort.'
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message',
        role: 'user',
        text: 'Split the analysis by cohort.'
      })
    )
  })

  it('rejects and settles feedback when its owning interaction is superseded during persistence', async () => {
    const onEvent = vi.fn()
    const { runtime, interactions, service, setCurrentInteraction } = createRuntimeHarness({
      onEvent
    })
    const pendingApproval = runtime
      .callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
      .catch((error: unknown) => error)
    await Promise.resolve()
    onEvent.mockClear()
    let markRespondStarted!: () => void
    let finishRespond!: () => void
    const respondStarted = new Promise<void>((resolve) => {
      markRespondStarted = resolve
    })
    const respondGate = new Promise<void>((resolve) => {
      finishRespond = resolve
    })
    let messagePersisted = false
    service.respond.mockImplementationOnce(async (input) => {
      markRespondStarted()
      await respondGate
      input.beforeFeedbackPersist?.()
      messagePersisted = true
      interactions.release('session-1', 'version-1')
      return {
        kind: 'feedback' as const,
        routeToInteractionId: 'interaction-1',
        artifactVersionId: 'version-1',
        text: input.feedback,
        message: {
          id: 'message-1',
          role: 'user' as const,
          content: input.feedback,
          status: 'complete' as const,
          eventIds: [],
          responseToMessageId: 'interaction-1',
          createdAt: 10,
          updatedAt: 10
        }
      }
    })

    const response = runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    })
    await respondStarted
    setCurrentInteraction({ sequence: 8, promptMessageId: 'interaction-2' })
    finishRespond()

    await expect(response).rejects.toThrow('no longer available')
    await expect(pendingApproval).resolves.toBeInstanceOf(Error)
    expect(messagePersisted).toBe(false)
    expect(interactions.approvalInteractionIdFor('session-1')).toBeUndefined()
    expect(
      interactions.isAgentDecisionAuthorized({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: 8
      })
    ).toBe(false)
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'message', messageId: 'message-1' })
    )
  })

  it('lets the resumed Agent explicitly approve after interpreting a user Message', async () => {
    const { runtime, service } = createRuntimeHarness({})
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await Promise.resolve()
    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: '批准执行'
    })
    await pending

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).resolves.toMatchObject({ projection: { approval: 'approved' } })
    expect(service.respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'approved', interactionIsLive: true })
    )
  })

  it('lets the resumed Agent explicitly reject after interpreting a user Message', async () => {
    const { runtime, service } = createRuntimeHarness({})
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await Promise.resolve()
    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: '取消计划'
    })
    await pending

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'reject'
      })
    ).resolves.toMatchObject({ projection: { approval: 'rejected' } })
    expect(service.respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'rejected', interactionIsLive: true })
    )
  })

  it('reports pending approval before Agent decision admission when the Agent skips its decision', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({})

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).rejects.toMatchObject({ code: 'plan-not-approved' })
    expect(updateStepStatus).toHaveBeenCalledOnce()
  })

  it('marks approval as passive when restart left no in-process approval waiter', async () => {
    const { runtime, service } = createRuntimeHarness({})

    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      decision: 'approved'
    })

    expect(service.respond).toHaveBeenCalledWith(
      expect.objectContaining({ interactionIsLive: false })
    )
  })

  it('clears only the deleted Session Plan interaction state', async () => {
    const { runtime, interactions } = createRuntimeHarness({})
    interactions.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionId: 'interaction-1'
    })
    const approval = interactions.parkApproval('session-1', 'interaction-1').catch((error) => error)

    await runtime.deleteSession({ sessionId: 'session-1' })

    await expect(approval).resolves.toMatchObject({
      message: 'The Session Plan interaction was deleted.'
    })
    expect(interactions.interactionIdFor('session-1', 'version-1')).toBeUndefined()
  })
})
