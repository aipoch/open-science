import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const loggerSpies = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: loggerSpies.info,
      warn: vi.fn(),
      error: loggerSpies.error
    })
  }
})

import type { AcpPromptRequest } from '../../shared/acp'
import type { SessionPlanDelivery, SessionRuntimeContext } from '../../shared/session-persistence'
import type { ActivePlanProjection, PlanResponseCommand } from '../../shared/session-plan/contract'
import { PlanService } from '../session-plan/plan-service'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import { composeAcpRuntimePlanWorkflow } from './runtime-plan-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpPromptTurnMode } from './prompt-turn-workflow'

const projectRoot = resolve(__dirname, '../../..')

const pendingProjection = (): ActivePlanProjection => ({
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  originatingPromptMessageId: 'prompt-1',
  revision: 1,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  document: {
    schema_version: 1,
    task_summary: 'private-task-summary-marker',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [
              { title: 'private-step-title-marker', description: 'private-step-description-marker' }
            ]
          }
        ]
      }
    ],
    desired_outputs: ['Result'],
    feasibility: { confidence: 'high', rationale: 'Ready.' }
  },
  stepStatuses: {},
  stepStates: { 'private-step-title-marker': { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
})

const approvedProjection = (revision: number): ActivePlanProjection => ({
  ...pendingProjection(),
  revision,
  approval: 'approved',
  lifecycle: 'approved'
})

const createHarness = (
  options: Readonly<{
    initialProjection?: ActivePlanProjection
    containsOriginatingMessage?: boolean
    deliveryContext?: Readonly<{
      delivery: SessionPlanDelivery
      projection: ActivePlanProjection
      reviewFeedbackMessageId?: string
    }>
  }> = {}
): {
  workflow: ReturnType<typeof composeAcpRuntimePlanWorkflow>
  interactions: SessionPlanInteractionOwner
  sessionInteractions: AcpSessionInteractionOwner
  interaction: ReturnType<AcpSessionInteractionOwner['claim']>
  respond: ReturnType<typeof vi.fn>
  queueSettledDecisionDelivery: ReturnType<typeof vi.fn>
  queueReviewFeedbackDelivery: ReturnType<typeof vi.fn>
  getProjection: ReturnType<typeof vi.fn>
  getDeliveryContext: ReturnType<typeof vi.fn>
  containsMessageOnActiveBranch: ReturnType<typeof vi.fn>
  deliveryState: () => 'queued' | 'delivering' | 'accepted' | undefined
  deliveries: Readonly<{
    accept: ReturnType<typeof vi.fn>
    begin: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
    rearmUnaccepted: ReturnType<typeof vi.fn>
  }>
} => {
  const interactions = new SessionPlanInteractionOwner()
  const sessionInteractions = new AcpSessionInteractionOwner()
  const interaction = sessionInteractions.claim({
    sessionId: 'session-1',
    kind: 'prompt',
    promptMessageId: 'prompt-1'
  })
  let current = options.initialProjection ?? pendingProjection()
  let deliveryState: 'queued' | 'delivering' | 'accepted' | undefined
  const generate = vi.fn(async () => {
    interactions.register({
      sessionId: 'session-1',
      artifactVersionId: current.artifactVersionId,
      interactionId: 'prompt-1'
    })
    return { projection: current, pauseInteraction: true as const }
  })
  const respond = vi.fn(async (rawInput: unknown) => {
    const input = rawInput as {
      feedback?: string
      decision?: 'approved' | 'rejected'
      beforeDecisionCommit?: () => boolean
      beforeFeedbackPersist?: () => void
    }
    if (input.feedback !== undefined) {
      input.beforeFeedbackPersist?.()
      interactions.release('session-1', current.artifactVersionId)
      current = { ...current, revision: current.revision + 1 }
      deliveryState = 'queued'
      return {
        kind: 'feedback' as const,
        routeToInteractionId: 'prompt-1',
        artifactVersionId: current.artifactVersionId,
        planRevision: current.revision,
        deliveryCommandId: 'receipt-1',
        text: input.feedback,
        message: {
          id: 'feedback-message-1',
          role: 'user' as const,
          content: input.feedback,
          createdAt: 42,
          responseToMessageId: 'prompt-1'
        }
      }
    }
    if (input.beforeDecisionCommit && !input.beforeDecisionCommit()) {
      throw new Error('decision authorization revoked')
    }
    current =
      input.decision === 'approved'
        ? approvedProjection(current.revision + 1)
        : {
            ...current,
            revision: current.revision + 1,
            approval: 'rejected' as const,
            lifecycle: 'rejected' as const
          }
    deliveryState = 'queued'
    return { projection: current, changed: true, deliveryCommandId: 'receipt-1' }
  })
  const updateStepStatus = vi.fn(
    async (input: {
      authorizeUpdate?: (projection: ActivePlanProjection) => void | Promise<void>
    }) => {
      await input.authorizeUpdate?.(current)
      current = approvedProjection(current.revision + 1)
      return { projection: current, changed: true }
    }
  )
  const queueSettledDecisionDelivery = vi.fn(async () => {
    deliveryState = 'queued'
    return { projection: current, changed: true }
  })
  const queueReviewFeedbackDelivery = vi.fn(async () => {
    deliveryState = 'queued'
    return { projection: current, changed: true }
  })
  const getProjection = vi.fn(async () => current)
  const getDeliveryContext = vi.fn(async () => {
    if (!options.deliveryContext) throw new Error('No delivery context configured.')
    return options.deliveryContext
  })
  const service = {
    generate,
    respond,
    updateStepStatus,
    queueSettledDecisionDelivery,
    queueReviewFeedbackDelivery,
    getProjection,
    getDeliveryContext
  }
  const deliveries = {
    accept: vi.fn(async () => {
      if (deliveryState !== 'delivering') return false
      deliveryState = 'accepted'
      current = { ...current, revision: current.revision + 1 }
      return true
    }),
    begin: vi.fn(async () => {
      if (deliveryState !== 'queued') return false
      deliveryState = 'delivering'
      current = { ...current, revision: current.revision + 1 }
      return true
    }),
    clear: vi.fn(async () => {
      if (deliveryState !== 'accepted' && deliveryState !== 'delivering') return false
      deliveryState = undefined
      current = { ...current, revision: current.revision + 1 }
      return true
    }),
    rearmUnaccepted: vi.fn(async () => {
      if (deliveryState !== 'delivering') return false
      deliveryState = 'queued'
      current = { ...current, revision: current.revision + 1 }
      return true
    })
  }
  const publication = { pushEvent: vi.fn() }
  const containsMessageOnActiveBranch = vi.fn(
    async () => options.containsOriginatingMessage ?? true
  )
  const workflow = composeAcpRuntimePlanWorkflow(
    {
      plan: {
        sessions: { containsMessageOnActiveBranch }
      }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[0],
    {
      planService: service,
      planInteractions: interactions,
      sessionInteractions,
      artifactTurns: {
        handleForExecution: vi.fn(() => 'artifact-turn'),
        snapshot: vi.fn(() => ({ promptMessageId: 'prompt-1' }))
      }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
    {
      publication,
      sessionEnvironment: { projectId: vi.fn(() => 'project-1') }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2],
    { deliveries }
  )

  return {
    workflow,
    interactions,
    sessionInteractions,
    interaction,
    respond,
    queueSettledDecisionDelivery,
    queueReviewFeedbackDelivery,
    getProjection,
    getDeliveryContext,
    containsMessageOnActiveBranch,
    deliveryState: () => deliveryState,
    deliveries
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ACP Session Plan approval causality', () => {
  it('aborts generate by clearing the real approval waiter while retaining the pending Plan', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const generation = harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {},
      signal: controller.signal
    })
    await vi.waitFor(() =>
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    )

    controller.abort()

    await expect(generation).rejects.toThrow('Session Plan RPC transport disconnected.')
    expect(harness.interactions.approvalInteractionIdFor('session-1')).toBeUndefined()
    await expect(harness.workflow.projection('project-1', 'session-1')).resolves.toMatchObject({
      approval: 'pending'
    })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('rejects concurrent Agent self-approval, then accepts one decision after routed human feedback', async () => {
    const harness = createHarness()
    const generation = harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await vi.waitFor(() =>
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    )

    await expect(
      harness.workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(harness.respond).not.toHaveBeenCalled()

    const feedback = await harness.workflow.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'private-feedback-marker'
    })
    await expect(generation).resolves.toEqual(feedback)
    expect(harness.deliveries.begin).toHaveBeenCalledWith('project-1', 'session-1', 'receipt-1')
    expect(harness.deliveries.clear).toHaveBeenCalledWith('project-1', 'session-1', 'receipt-1')
    expect(feedback).not.toHaveProperty('deliveryCommandId')

    await expect(
      harness.workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).resolves.toMatchObject({ projection: { approval: 'approved' } })

    await harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'updateStepStatus',
      input: { title: 'private-step-title-marker', status: 'in_progress' }
    })

    expect(loggerSpies.info).toHaveBeenCalledWith(
      'Session Plan response accepted',
      expect.objectContaining({ source: 'agent-after-feedback', decision: 'approved' })
    )
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'Session Plan step status updated',
      expect.objectContaining({ status: 'in_progress', changed: true })
    )
    const auditPayload = JSON.stringify(loggerSpies.info.mock.calls)
    expect(auditPayload).not.toContain('private-feedback-marker')
    expect(auditPayload).not.toContain('private-task-summary-marker')
    expect(auditPayload).not.toContain('private-step-title-marker')
    expect(auditPayload).not.toContain('private-step-description-marker')
    harness.sessionInteractions.release(harness.interaction)
  })

  it('keeps a direct human Plan button authoritative and audits its source', async () => {
    const harness = createHarness()
    const generation = harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await vi.waitFor(() =>
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    )
    harness.interactions.authorizeAgentDecision({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionSequence: harness.interaction.sequence
    })

    const decision: PlanResponseCommand = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      decision: 'approved'
    }
    const result = await harness.workflow.respond(decision)

    await expect(generation).resolves.toEqual(result)
    expect(
      harness.interactions.isAgentDecisionAuthorized({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: harness.interaction.sequence
      })
    ).toBe(false)
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'Session Plan response accepted',
      expect.objectContaining({ source: 'human-button', decision: 'approved' })
    )
    expect(harness.deliveries.begin).toHaveBeenCalledOnce()
    expect(harness.deliveries.clear).toHaveBeenCalledOnce()
    expect(harness.deliveries.rearmUnaccepted).not.toHaveBeenCalled()
    expect('projection' in result && result.projection).not.toHaveProperty('delivery')
    harness.sessionInteractions.release(harness.interaction)
  })

  it('retains a queued decision receipt when the app exits before live handoff begins', async () => {
    const harness = createHarness()
    const generation = harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    void generation.catch(() => undefined)
    await vi.waitFor(() =>
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    )
    harness.deliveries.begin.mockRejectedValueOnce(new Error('app exited'))

    await expect(
      harness.workflow.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        expectedRevision: 1,
        decision: 'approved'
      })
    ).rejects.toThrow('app exited')

    await expect(harness.workflow.projection('project-1', 'session-1')).resolves.toMatchObject({
      approval: 'approved'
    })
    expect(harness.deliveryState()).toBe('queued')
    expect(harness.deliveries.clear).not.toHaveBeenCalled()
    harness.interactions.rejectApproval('session-1', 'test cleanup')
  })

  it.each(['decision', 'feedback'] as const)(
    'keeps a claimed %s receipt delivering when live handoff throws',
    async (kind) => {
      const harness = createHarness()
      const generation = harness.workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
      void generation.catch(() => undefined)
      await vi.waitFor(() =>
        expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
      )
      vi.spyOn(harness.interactions, 'resolveApproval').mockImplementationOnce(() => {
        throw new Error('handoff failed')
      })

      const response =
        kind === 'decision'
          ? harness.workflow.respond({
              projectId: 'project-1',
              sessionId: 'session-1',
              artifactVersionId: 'version-1',
              expectedRevision: 1,
              decision: 'approved'
            })
          : harness.workflow.respond({
              projectId: 'project-1',
              sessionId: 'session-1',
              feedback: 'Split the analysis by cohort.'
            })

      await expect(response).rejects.toThrow('handoff failed')
      expect(harness.deliveryState()).toBe('delivering')
      expect(harness.deliveries.clear).not.toHaveBeenCalled()
      expect(harness.deliveries.rearmUnaccepted).not.toHaveBeenCalled()
      harness.interactions.rejectApproval('session-1', 'test cleanup')
    }
  )

  it.each(['decision', 'feedback'] as const)(
    'rearms a claimed %s receipt when the live waiter disappears during handoff',
    async (kind) => {
      const harness = createHarness()
      const generation = harness.workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
      void generation.catch(() => undefined)
      await vi.waitFor(() =>
        expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
      )
      vi.spyOn(harness.interactions, 'resolveApproval').mockReturnValueOnce(false)

      await (kind === 'decision'
        ? harness.workflow.respond({
            projectId: 'project-1',
            sessionId: 'session-1',
            artifactVersionId: 'version-1',
            expectedRevision: 1,
            decision: 'approved'
          })
        : harness.workflow.respond({
            projectId: 'project-1',
            sessionId: 'session-1',
            feedback: 'Split the analysis by cohort.'
          }))

      expect(harness.deliveries.begin).toHaveBeenCalledOnce()
      expect(harness.deliveries.rearmUnaccepted).toHaveBeenCalledOnce()
      expect(harness.deliveries.clear).not.toHaveBeenCalled()
      expect(harness.deliveryState()).toBe('queued')
      harness.interactions.rejectApproval('session-1', 'test cleanup')
    }
  )

  it.each(['approved', 'rejected'] as const)(
    'keeps a durable %s delivery queued when transport detaches after decision commit',
    async (decision) => {
      const harness = createHarness()
      const generation = harness.workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
      void generation.catch(() => undefined)
      await vi.waitFor(() =>
        expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
      )
      harness.respond.mockImplementationOnce(async (rawInput: unknown) => {
        const input = rawInput as { beforeDecisionCommit?: () => boolean }
        expect(input.beforeDecisionCommit?.()).toBe(true)
        harness.interactions.rejectApproval('session-1', 'transport detached')
        return {
          projection:
            decision === 'approved'
              ? approvedProjection(2)
              : {
                  ...pendingProjection(),
                  revision: 2,
                  approval: 'rejected' as const,
                  lifecycle: 'rejected' as const
                },
          changed: true,
          deliveryCommandId: 'receipt-1'
        }
      })

      const result = await harness.workflow.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        expectedRevision: 1,
        decision
      })

      expect(harness.queueSettledDecisionDelivery).not.toHaveBeenCalled()
      expect(harness.deliveries.begin).not.toHaveBeenCalled()
      expect('projection' in result && result.projection).not.toHaveProperty('delivery')
    }
  )

  it('queues durable review feedback when transport detaches after its Message commit', async () => {
    const harness = createHarness()
    const generation = harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    void generation.catch(() => undefined)
    await vi.waitFor(() =>
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    )
    harness.respond.mockImplementationOnce(async (rawInput: unknown) => {
      const input = rawInput as { beforeFeedbackPersist?: () => void; feedback: string }
      input.beforeFeedbackPersist?.()
      harness.interactions.release('session-1', 'version-1')
      harness.interactions.rejectApproval('session-1', 'transport detached')
      return {
        kind: 'feedback' as const,
        routeToInteractionId: 'prompt-1',
        artifactVersionId: 'version-1',
        planRevision: 2,
        deliveryCommandId: 'receipt-1',
        text: input.feedback,
        message: {
          id: 'feedback-message-1',
          role: 'user' as const,
          content: input.feedback,
          createdAt: 42,
          responseToMessageId: 'prompt-1'
        }
      }
    })

    const result = await harness.workflow.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    })

    expect(harness.queueReviewFeedbackDelivery).not.toHaveBeenCalled()
    expect(harness.deliveries.begin).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('projection')
  })
})

describe('ACP Runtime Session Plan composition', () => {
  it.each(['user', 'application'] as const)(
    'reconstructs an approved durable Plan for an ordinary %s Attempt',
    async (kind) => {
      const harness = createHarness({ initialProjection: approvedProjection(4) })
      const request: AcpPromptRequest = { sessionId: 'session-1', text: 'Continue the work.' }
      if (harness.interaction.kind !== 'prompt') throw new Error('Expected a prompt interaction.')
      const mode: AcpPromptTurnMode =
        kind === 'user'
          ? { kind }
          : {
              kind,
              attribution: {
                kind: 'application',
                feature: 'compute',
                purpose: 'job-completion-analysis',
                deliveryKey: 'compute-delivery-1',
                jobIds: ['job-1']
              }
            }

      const preflight = await harness.workflow.prompt.preflight(request, mode)
      const admitted = await harness.workflow.prompt.admit(request, harness.interaction, preflight)

      expect(admitted.active).toMatchObject({
        approval: 'approved',
        artifactVersionId: 'version-1',
        revision: 4
      })
      expect(harness.getProjection).toHaveBeenCalledWith('project-1', 'session-1')
      expect(harness.containsMessageOnActiveBranch).toHaveBeenCalledWith(
        'project-1',
        'session-1',
        'prompt-1'
      )
    }
  )

  it.each([
    ['pending', pendingProjection()],
    ['completed', { ...approvedProjection(4), lifecycle: 'completed' as const }],
    ['blocked', { ...approvedProjection(4), lifecycle: 'blocked' as const }],
    [
      'rejected',
      {
        ...pendingProjection(),
        approval: 'rejected' as const,
        lifecycle: 'rejected' as const
      }
    ]
  ])('does not reconstruct a %s Plan as active Attempt context', async (_state, current) => {
    const harness = createHarness({ initialProjection: current })
    const request: AcpPromptRequest = { sessionId: 'session-1', text: 'New work.' }

    expect(await harness.workflow.prompt.preflight(request, { kind: 'user' })).toEqual({})
    expect(harness.containsMessageOnActiveBranch).not.toHaveBeenCalled()
  })

  it.each([
    ['a sibling branch', approvedProjection(4), false],
    [
      'a legacy Plan without an originating Message',
      { ...approvedProjection(4), originatingPromptMessageId: undefined },
      true
    ]
  ])('fails closed for %s when reconstructing Attempt context', async (_name, current, visible) => {
    const harness = createHarness({
      initialProjection: current,
      containsOriginatingMessage: visible
    })
    const request: AcpPromptRequest = { sessionId: 'session-1', text: 'New work.' }

    expect(await harness.workflow.prompt.preflight(request, { kind: 'user' })).toEqual({})
  })

  it('admits pending review context only from an exact main-owned delivery receipt', async () => {
    const pending = pendingProjection()
    const harness = createHarness({
      deliveryContext: {
        delivery: {
          commandId: 'delivery-1',
          kind: 'review-feedback',
          state: 'delivering',
          originatingPromptMessageId: 'feedback-message-1',
          createdAt: 42
        },
        projection: pending,
        reviewFeedbackMessageId: 'feedback-message-1'
      }
    })
    if (harness.interaction.kind !== 'prompt') throw new Error('Expected a prompt interaction.')
    const request: AcpPromptRequest = { sessionId: 'session-1', text: 'Apply the review.' }

    const preflight = await harness.workflow.prompt.preflight(request, {
      kind: 'app-continuation',
      planDelivery: { projectId: 'project-1', commandId: 'delivery-1' }
    })
    const admitted = await harness.workflow.prompt.admit(request, harness.interaction, preflight)

    expect(admitted.protectedPending).toEqual(pending)
    expect(harness.getDeliveryContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      commandId: 'delivery-1'
    })
    expect(harness.containsMessageOnActiveBranch).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      'feedback-message-1'
    )
    expect(
      harness.interactions.isAgentDecisionAuthorized({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: harness.interaction.sequence
      })
    ).toBe(true)
  })

  it('rejects a main-owned Plan delivery whose originating Message is on a sibling branch', async () => {
    const approved = approvedProjection(4)
    const harness = createHarness({
      containsOriginatingMessage: false,
      deliveryContext: {
        delivery: {
          commandId: 'delivery-1',
          kind: 'approved-plan',
          state: 'delivering',
          originatingPromptMessageId: 'sibling-plan-origin',
          createdAt: 42
        },
        projection: approved
      }
    })

    await expect(
      harness.workflow.prompt.preflight(
        { sessionId: 'session-1', text: 'Start the approved Plan.' },
        {
          kind: 'app-continuation',
          planDelivery: { projectId: 'project-1', commandId: 'delivery-1' }
        }
      )
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
  })

  it('loads the authoritative Plan once when updating a step', async () => {
    const interactions = new SessionPlanInteractionOwner()
    const sessionInteractions = new AcpSessionInteractionOwner()
    const document = approvedProjection(4).document
    const content = JSON.stringify(document)
    const checksum = createHash('sha256').update(content).digest('hex')
    let context: SessionRuntimeContext = {
      version: 1,
      revision: 4,
      plan: {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactChecksum: checksum,
        originatingPromptMessageId: 'prompt-1',
        materializedAt: 1,
        approval: 'approved',
        stepStatuses: {}
      }
    }
    const readRuntimeContext = vi.fn(async () => context)
    const readArtifactVersion = vi.fn(async () => ({ content, checksum }))
    const service = new PlanService({
      interactions,
      writeArtifactForExecution: vi.fn(),
      readArtifactVersion,
      readRuntimeContext,
      patchRuntimeContext: vi.fn(async ({ expectedRevision, plan }) => {
        if (expectedRevision !== context.revision) throw new Error('revision conflict')
        context = { version: 1, revision: context.revision + 1, plan }
        return context
      }),
      isRevisionConflict: (error) =>
        error instanceof Error && error.message === 'revision conflict',
      persistUserMessage: vi.fn(),
      now: () => 42
    })
    const publication = { pushEvent: vi.fn() }
    const workflow = composeAcpRuntimePlanWorkflow(
      {
        plan: { sessions: { containsMessageOnActiveBranch: vi.fn(async () => true) } }
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[0],
      {
        planService: service,
        planInteractions: interactions,
        sessionInteractions
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
      {
        publication,
        sessionEnvironment: { projectId: vi.fn(() => 'project-1') }
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2]
    )

    await expect(
      workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'private-step-title-marker', status: 'in_progress' }
      })
    ).resolves.toMatchObject({
      changed: true,
      projection: {
        revision: 5,
        stepStatuses: { 'private-step-title-marker': { status: 'in_progress' } }
      }
    })
    expect(readRuntimeContext).toHaveBeenCalledOnce()
    expect(readArtifactVersion).toHaveBeenCalledOnce()
    expect(publication.pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'plan',
        planProjection: expect.objectContaining({ revision: 5 })
      })
    )
  })

  it('publishes the latest Plan after an admitted terminal update becomes idempotent concurrently', async () => {
    const interactions = new SessionPlanInteractionOwner()
    const sessionInteractions = new AcpSessionInteractionOwner()
    const document = approvedProjection(4).document
    const content = JSON.stringify(document)
    const checksum = createHash('sha256').update(content).digest('hex')
    const completedStatus = { status: 'completed' as const, updatedAt: 40 }
    let context: SessionRuntimeContext = {
      version: 1,
      revision: 4,
      plan: {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactChecksum: checksum,
        originatingPromptMessageId: 'prompt-1',
        materializedAt: 1,
        approval: 'approved',
        stepStatuses: { 'private-step-title-marker': completedStatus }
      }
    }
    const readRuntimeContext = vi.fn(async () => context)
    const readArtifactVersion = vi.fn(async () => ({ content, checksum }))
    const patchRuntimeContext = vi.fn()
    const service = new PlanService({
      interactions,
      writeArtifactForExecution: vi.fn(),
      readArtifactVersion,
      readRuntimeContext,
      patchRuntimeContext,
      isRevisionConflict: (error) =>
        error instanceof Error && error.message === 'revision conflict',
      persistUserMessage: vi.fn(),
      now: () => 42
    })
    const containsMessageOnActiveBranch = vi.fn(async () => {
      context = {
        ...context,
        revision: 5,
        plan: {
          ...context.plan!,
          stepStatuses: {
            'private-step-title-marker': {
              ...completedStatus,
              notes: 'Recorded by the concurrent writer.'
            }
          }
        }
      }
      return true
    })
    const publication = { pushEvent: vi.fn() }
    const workflow = composeAcpRuntimePlanWorkflow(
      {
        plan: { sessions: { containsMessageOnActiveBranch } }
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[0],
      {
        planService: service,
        planInteractions: interactions,
        sessionInteractions
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
      {
        publication,
        sessionEnvironment: { projectId: vi.fn(() => 'project-1') }
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2]
    )

    await expect(
      workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'private-step-title-marker', status: 'completed' }
      })
    ).resolves.toMatchObject({
      changed: false,
      projection: {
        revision: 5,
        stepStatuses: {
          'private-step-title-marker': {
            status: 'completed',
            notes: 'Recorded by the concurrent writer.'
          }
        }
      }
    })
    expect(readRuntimeContext).toHaveBeenCalledTimes(2)
    expect(readArtifactVersion).toHaveBeenCalledOnce()
    expect(patchRuntimeContext).not.toHaveBeenCalled()
    expect(context.revision).toBe(5)
    expect(publication.pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'plan',
        planProjection: expect.objectContaining({
          revision: 5,
          stepStatuses: {
            'private-step-title-marker': expect.objectContaining({
              notes: 'Recorded by the concurrent writer.'
            })
          }
        })
      })
    )
  })

  it('atomically records detached feedback before allowing a revised Plan generation', async () => {
    const interactions = new SessionPlanInteractionOwner()
    const sessionInteractions = new AcpSessionInteractionOwner()
    let context: SessionRuntimeContext = { version: 1, revision: 0 }
    let version = 0
    const artifacts = new Map<string, { content: string; checksum: string }>()
    const persistUserMessage = vi.fn(
      async (input: {
        content: string
        interactionId: string
        beforePersist?: () => void
        markPlanReview?: {
          expectedRevision: number
          plan: NonNullable<SessionRuntimeContext['plan']>
          commandId: string
          createdAt: number
        }
      }) => {
        input.beforePersist?.()
        const review = input.markPlanReview
        if (!review || review.expectedRevision !== context.revision) {
          throw new Error('revision conflict')
        }
        const message = {
          id: 'feedback-message-1',
          role: 'user' as const,
          content: input.content,
          status: 'complete' as const,
          eventIds: [],
          createdAt: 42,
          updatedAt: 42,
          responseToMessageId: input.interactionId
        }
        context = {
          version: 1,
          revision: context.revision + 1,
          plan: {
            ...review.plan,
            reviewFeedbackMessageId: message.id,
            delivery: {
              commandId: review.commandId,
              kind: 'review-feedback',
              state: 'queued',
              originatingPromptMessageId: message.id,
              createdAt: review.createdAt
            }
          }
        }
        return message
      }
    )
    const service = new PlanService({
      interactions,
      writeArtifactForExecution: vi.fn(async (_executionId, input) => {
        version += 1
        const versionId = `version-${version}`
        const checksum = createHash('sha256').update(input.content).digest('hex')
        artifacts.set(versionId, { content: input.content, checksum })
        return { artifactId: 'artifact-1', versionId, checksum, name: input.filename }
      }),
      readArtifactVersion: vi.fn(async ({ artifactVersionId }) =>
        artifacts.get(artifactVersionId)!
      ),
      readRuntimeContext: vi.fn(async () => context),
      patchRuntimeContext: vi.fn(async ({ expectedRevision, plan }) => {
        if (expectedRevision !== context.revision) throw new Error('revision conflict')
        context = { version: 1, revision: context.revision + 1, ...(plan ? { plan } : {}) }
        return context
      }),
      isRevisionConflict: (error) =>
        error instanceof Error && error.message === 'revision conflict',
      persistUserMessage,
      now: () => 42,
      createId: () => `plan-${version + 1}`,
      createCommandId: () => 'feedback-command-1'
    })
    const originalContent = {
      task_summary: 'Analyze the dataset.',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: [{ title: 'Analyze', description: 'Analyze the dataset.' }]
            }
          ]
        }
      ],
      desired_outputs: ['Result'],
      feasibility: { confidence: 'high' as const, rationale: 'Ready.' }
    }
    const original = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'original-turn',
      interactionId: 'plan-origin',
      content: originalContent
    })
    interactions.release('session-1', original.projection.artifactVersionId)
    const workflow = composeAcpRuntimePlanWorkflow(
      {
        plan: { sessions: { containsMessageOnActiveBranch: vi.fn(async () => true) } }
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[0],
      {
        planService: service,
        planInteractions: interactions,
        sessionInteractions,
        artifactTurns: {
          handleForExecution: vi.fn(() => 'revision-turn'),
          snapshot: vi.fn(() => ({ promptMessageId: 'revision-prompt' }))
        }
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
      {
        publication: { pushEvent: vi.fn() },
        sessionEnvironment: { projectId: vi.fn(() => 'project-1') }
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2]
    )

    const feedback = await workflow.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    })

    expect(feedback).toMatchObject({
      kind: 'feedback',
      message: { id: 'feedback-message-1' },
      deliveryCommandId: 'feedback-command-1'
    })
    expect(persistUserMessage).toHaveBeenCalledTimes(1)
    expect(context.plan).toMatchObject({
      reviewFeedbackMessageId: 'feedback-message-1',
      delivery: { kind: 'review-feedback', state: 'queued' }
    })

    const revisionInteraction = sessionInteractions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'revision-prompt'
    })
    const revised = workflow
      .call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: { ...originalContent, task_summary: 'Analyze the dataset by cohort.' }
      })
      .catch((error: unknown) => error)
    await vi.waitFor(async () =>
      expect(await workflow.projection('project-1', 'session-1')).toMatchObject({
        approval: 'pending',
        document: { task_summary: 'Analyze the dataset by cohort.' }
      })
    )
    interactions.rejectApproval('session-1', 'test cleanup')
    await expect(revised).resolves.toBeInstanceOf(Error)
    sessionInteractions.release(revisionInteraction)
  })

  it('clears exact decision authorization when prompt supersession releases first', () => {
    const harness = createHarness()
    if (harness.interaction.kind !== 'prompt') throw new Error('Expected a prompt interaction.')
    const authorization = {
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionSequence: harness.interaction.sequence
    }
    harness.interactions.authorizeAgentDecision(authorization)
    const cancel = harness.workflow.capturePromptCancellation('session-1')

    harness.sessionInteractions.release(harness.interaction)
    cancel()

    expect(harness.interactions.isAgentDecisionAuthorized(authorization)).toBe(false)
  })

  it('builds a fresh frozen workflow without publishing or requiring Plan capability', async () => {
    const options = { appVersion: 'test', defaultCwd: '/workspace' }
    const create = (): ReturnType<typeof composeAcpRuntimePlanWorkflow> => {
      const base = composeAcpRuntimeBaseOwners(options)
      const session = composeAcpRuntimeSessionOwners(options, base)
      const workflow = composeAcpRuntimePlanWorkflow(options, base, session)

      expect(session.publication.getSnapshot().events).toEqual([])
      return workflow
    }

    const first = create()
    const second = create()

    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.prompt)).toBe(true)
    expect(first).not.toBe(second)
    await expect(first.projection('project', 'session')).resolves.toBeNull()
    await expect(
      first.call({ projectId: 'project', sessionId: 'session', operation: 'approve' })
    ).rejects.toThrow('Session Plan capability is not configured.')
    await expect(
      first.respond({ projectId: 'project', sessionId: 'session', feedback: 'continue' })
    ).rejects.toThrow('Session Plan capability is not configured.')
  })

  it('keeps Plan state and Prompt policy behind one transport-independent workflow', () => {
    const runtime = readFileSync(resolve(projectRoot, 'src/main/acp/runtime.ts'), 'utf8')
    const plan = readFileSync(
      resolve(projectRoot, 'src/main/acp/runtime-plan-composition.ts'),
      'utf8'
    )
    const prompt = readFileSync(
      resolve(projectRoot, 'src/main/acp/runtime-prompt-composition.ts'),
      'utf8'
    )

    expect(runtime).not.toMatch(
      /private readonly (?:planInteractions|planService)|private (?:preflightPromptPlan|admitPromptPlan|checkPromptPlanCompletion|releasePromptPlanBinding|rejectPlanApprovalForInteraction|publishTerminalPlanProjection)/
    )
    expect(runtime).toContain('plan: this.sessionPlanWorkflow.prompt')
    expect(runtime).toContain('this.sessionPlanWorkflow.capturePromptCancellation(')
    expect(runtime).toContain('this.sessionPlanWorkflow.sessionDeleted(request.sessionId)')
    expect(prompt).toContain('plan: host.plan')
    expect(plan).toContain('const prompt: AcpPromptTurnPlanWorkflow = Object.freeze({')
    expect(plan).not.toMatch(/from ['"]electron['"]|application-commands|ipc|runtime-coordinator/)
  })
})
