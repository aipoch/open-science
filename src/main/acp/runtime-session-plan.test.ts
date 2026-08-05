import { describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { AcpRuntime } from './runtime'

const projection = (artifactVersionId: string, revision = 1): ActivePlanProjection => ({
  artifactId: `artifact-${artifactVersionId}`,
  artifactVersionId,
  artifactChecksum: 'a'.repeat(64),
  revision,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
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
  'generate' | 'respond' | 'getProjection' | 'updateStepStatus' | 'checkTurnCompletion',
  ReturnType<typeof vi.fn>
>

type RuntimeHarness = Readonly<{
  runtime: AcpRuntime
  service: PlanServiceMock
  updateStepStatus: ReturnType<typeof vi.fn>
}>

const createRuntimeHarness = (options: {
  onEvent?: (event?: unknown) => void
  activeProjection?: ActivePlanProjection
}): RuntimeHarness => {
  const generated = projection('version-1')
  const approved = { ...generated, approval: 'approved' as const, lifecycle: 'approved' as const }
  const updateStepStatus = vi.fn(async () => ({ projection: approved, changed: true }))
  const service = {
    generate: vi.fn(async () => ({ projection: generated, pauseInteraction: true as const })),
    respond: vi.fn(async (input: { feedback?: string; decision?: 'approved' | 'rejected' }) =>
      input.feedback
        ? {
            kind: 'feedback' as const,
            routeToInteractionId: 'interaction-1',
            artifactVersionId: generated.artifactVersionId,
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
        : {
            projection:
              input.decision === 'rejected'
                ? { ...generated, approval: 'rejected' as const, lifecycle: 'rejected' as const }
                : approved,
            changed: true
          }
    ),
    getProjection: vi.fn(
      async (
        _projectId: string,
        _sessionId: string,
        projectionOptions?: { interactionIsLive?: boolean }
      ) => {
        const current = options.activeProjection ?? generated
        return projectionOptions?.interactionIsLive === false && current.lifecycle === 'in_progress'
          ? { ...current, lifecycle: 'interrupted' as const }
          : current
      }
    ),
    updateStepStatus,
    checkTurnCompletion: vi.fn(async () => ({ allow: true }))
  }
  const target = Object.create(AcpRuntime.prototype) as Record<string, unknown>
  Object.assign(target, {
    planService: service,
    sessionInteractions: {
      snapshot: () => [{ kind: 'prompt', sessionId: 'session-1' }],
      current: () => ({ kind: 'prompt', sessionId: 'session-1', sequence: 7 })
    },
    planExecutionBindings: new Map(),
    planApprovalWaiters: new Map(),
    artifactTurns: { promptMessageIdFor: () => 'interaction-1' },
    callbacks: { onEvent: options.onEvent },
    pushEvent: (event: unknown) => options.onEvent?.(event),
    resolveSessionProjectName: () => 'project-1'
  })
  return { runtime: target as unknown as AcpRuntime, service, updateStepStatus }
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

  it('rejects an MCP server-bound execution version after a replacement became active', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-2', 4),
        approval: 'approved',
        lifecycle: 'approved'
      }
    })
    ;(
      runtime as unknown as {
        planExecutionBindings: Map<
          string,
          { interactionSequence: number; artifactVersionId: string }
        >
      }
    ).planExecutionBindings.set('session-1', {
      interactionSequence: 7,
      artifactVersionId: 'version-1'
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
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(updateStepStatus).not.toHaveBeenCalled()
  })

  it('rejects Plan execution from an ordinary interaction without explicit continuation authority', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-1', 4),
        approval: 'approved',
        lifecycle: 'approved',
        requiresExplicitContinuation: true
      }
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).rejects.toMatchObject({ code: 'continuation-required' })
    expect(updateStepStatus).not.toHaveBeenCalled()
  })

  it('rejects a Plan version bound to a different interaction', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-2', 4),
        approval: 'approved',
        lifecycle: 'approved',
        requiresExplicitContinuation: true
      }
    })
    ;(
      runtime as unknown as {
        planExecutionBindings: Map<
          string,
          { interactionSequence: number; artifactVersionId: string }
        >
      }
    ).planExecutionBindings.set('session-1', {
      interactionSequence: 6,
      artifactVersionId: 'version-2'
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(updateStepStatus).not.toHaveBeenCalled()
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

  it('reports pending approval before continuation authority when the Agent skips its decision', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({})

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).rejects.toMatchObject({ code: 'plan-not-approved' })
    expect(updateStepStatus).not.toHaveBeenCalled()
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
})
