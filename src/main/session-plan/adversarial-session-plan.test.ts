import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  sanitizeSessionRuntimeContext,
  type SessionPlanRuntimeContext,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import {
  assertPlanDocumentCapacity,
  createPlanDocumentV1,
  derivePlanLifecycle,
  formatPlanProtectedContext,
  isPlanTerminalOutcome,
  PlanCommandError,
  planStepTitles,
  projectPlanStepStates,
  type ActivePlanProjection,
  type PlanDocumentV1
} from '../../shared/session-plan/contract'
import { matchPlanDelivery, matchesPlanDelivery } from './plan-delivery'
import { PlanService, type PlanServiceDependencies } from './plan-service'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'
import {
  SessionPlanDeliveryOwner,
  type SessionPlanDeliverySessions
} from '../acp/session-plan-delivery-owner'

const baseContent = {
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
  feasibility: { confidence: 'high' as const, rationale: 'Inputs are available.' }
}

const multiDelegationContent = {
  task_summary: 'Run a multi-track research plan',
  phases: [
    {
      name: 'Phase one',
      delegations: [
        {
          name: 'Track A',
          steps: [
            { title: 'A1', description: 'Start track A.' },
            { title: 'A2', description: 'Finish track A.' }
          ]
        },
        {
          name: 'Track B',
          steps: [{ title: 'B1', description: 'Start track B.' }]
        }
      ]
    },
    {
      name: 'Phase two',
      delegations: [
        {
          name: 'Synthesis',
          steps: [{ title: 'C1', description: 'Synthesize results.' }]
        }
      ]
    }
  ],
  desired_outputs: ['Report'],
  feasibility: { confidence: 'medium' as const, rationale: 'Feasible with current inputs.' }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const makePlanServiceHarness = (): {
  service: PlanService
  interactions: SessionPlanInteractionOwner
  dependencies: { -readonly [Key in keyof PlanServiceDependencies]: PlanServiceDependencies[Key] }
  context: () => SessionRuntimeContext
  setContext: (next: SessionRuntimeContext) => void
  artifactBytes: () => string
  setArtifactBytes: (content: string) => void
  onApprovalSettled: ReturnType<typeof vi.fn>
} => {
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  let bytes = ''
  const interactions = new SessionPlanInteractionOwner()
  const onApprovalSettled = vi.fn()
  const dependencies: {
    -readonly [Key in keyof PlanServiceDependencies]: PlanServiceDependencies[Key]
  } = {
    interactions,
    writeArtifactForExecution: vi.fn(async (_executionId, input) => {
      bytes = input.content
      return {
        artifactId: 'artifact-1',
        versionId: 'version-1',
        checksum: sha256(bytes),
        name: input.filename
      }
    }),
    readArtifactVersion: vi.fn(async () => ({
      content: bytes,
      checksum: sha256(bytes)
    })),
    readRuntimeContext: vi.fn(async () => context),
    patchRuntimeContext: vi.fn(async ({ expectedRevision, plan, sessionStatus, beforePersist }) => {
      if (expectedRevision !== context.revision) throw new Error('revision conflict')
      beforePersist?.()
      context = {
        version: 1,
        revision: context.revision + 1,
        ...(plan ? { plan } : {})
      }
      void sessionStatus
      return context
    }),
    isRevisionConflict: (error) => error instanceof Error && error.message === 'revision conflict',
    persistUserMessage: vi.fn(async (input) => {
      input.beforePersist?.()
      const message = {
        id: 'message-1',
        role: 'user' as const,
        content: input.content,
        status: 'complete' as const,
        eventIds: [],
        responseToMessageId: input.interactionId,
        createdAt: 42,
        updatedAt: 42
      }
      if (input.markPlanReview) {
        if (input.markPlanReview.expectedRevision !== context.revision) {
          throw new Error('revision conflict')
        }
        context = {
          version: 1,
          revision: context.revision + 1,
          plan: {
            ...input.markPlanReview.plan,
            reviewFeedbackMessageId: message.id,
            delivery: {
              commandId: input.markPlanReview.commandId,
              kind: 'review-feedback',
              state: 'queued',
              originatingPromptMessageId: message.id,
              createdAt: input.markPlanReview.createdAt
            }
          }
        }
      }
      return message
    }),
    now: () => 42,
    createId: () => 'a91f30c2',
    createCommandId: vi
      .fn<() => string>()
      .mockReturnValueOnce('delivery-1')
      .mockReturnValueOnce('delivery-2')
      .mockReturnValueOnce('delivery-3')
      .mockReturnValue('delivery-n'),
    onApprovalRequested: vi.fn(),
    onApprovalSettled
  }
  return {
    service: new PlanService(dependencies),
    interactions,
    dependencies,
    context: () => context,
    setContext: (next) => {
      context = next
    },
    artifactBytes: () => bytes,
    setArtifactBytes: (content) => {
      bytes = content
    },
    onApprovalSettled
  }
}

const generatePending = async (
  harness: ReturnType<typeof makePlanServiceHarness>,
  content: unknown = baseContent,
  interactionId = 'interaction-1'
): Promise<{ projection: ActivePlanProjection; artifactVersionId: string }> => {
  const generated = await harness.service.generate({
    projectId: 'project-1',
    sessionId: 'session-1',
    executionId: 'execution-1',
    interactionId,
    content: content as never
  })
  return {
    projection: generated.projection,
    artifactVersionId: generated.projection.artifactVersionId
  }
}

describe('adversarial Plan delivery matching', () => {
  const plan = (
    approval: SessionPlanRuntimeContext['approval'],
    delivery: SessionPlanRuntimeContext['delivery'],
    overrides: Partial<SessionPlanRuntimeContext> = {}
  ): SessionPlanRuntimeContext => ({
    artifactId: 'artifact-1',
    artifactVersionId: 'version-1',
    artifactChecksum: 'checksum-1',
    originatingPromptMessageId: 'prompt-1',
    approval,
    stepStatuses: {},
    ...(delivery ? { delivery } : {}),
    ...overrides
  })

  const approvedDelivery = {
    commandId: 'cmd-1',
    kind: 'approved-plan' as const,
    state: 'queued' as const,
    originatingPromptMessageId: 'prompt-1',
    createdAt: 1
  }

  it('does not match an approved-plan receipt while approval is still pending', () => {
    expect(
      matchPlanDelivery(plan('pending', approvedDelivery), { commandId: 'cmd-1' })
    ).toBeUndefined()
  })

  it('does not match a rejected-plan receipt against an approved Plan', () => {
    const rejectedDelivery = {
      ...approvedDelivery,
      kind: 'rejected-plan' as const,
      commandId: 'cmd-2'
    }
    expect(
      matchPlanDelivery(plan('approved', rejectedDelivery), { commandId: 'cmd-2' })
    ).toBeUndefined()
  })

  it('does not match review-feedback once the Plan is no longer pending', () => {
    const feedbackDelivery = {
      commandId: 'cmd-3',
      kind: 'review-feedback' as const,
      state: 'queued' as const,
      originatingPromptMessageId: 'feedback-1',
      createdAt: 2
    }
    expect(
      matchPlanDelivery(plan('approved', feedbackDelivery), { commandId: 'cmd-3' })
    ).toBeUndefined()
  })

  it('routes review-feedback identity through reviewFeedbackMessageId, not originating prompt', () => {
    const feedbackDelivery = {
      commandId: 'cmd-4',
      kind: 'review-feedback' as const,
      state: 'delivering' as const,
      originatingPromptMessageId: 'feedback-msg',
      createdAt: 3
    }
    const pending = plan('pending', feedbackDelivery, {
      originatingPromptMessageId: 'prompt-1',
      reviewFeedbackMessageId: 'feedback-msg'
    })
    expect(matchPlanDelivery(pending, { commandId: 'cmd-4' })?.originatingPromptMessageId).toBe(
      'feedback-msg'
    )
    expect(
      matchesPlanDelivery(
        { ...pending, reviewFeedbackMessageId: 'other-feedback' },
        feedbackDelivery,
        { commandId: 'cmd-4' }
      )
    ).toBe(false)
  })

  it('requires a durable originating prompt on the Plan itself', () => {
    const withoutOrigin = plan('approved', approvedDelivery, {
      originatingPromptMessageId: undefined
    })
    Reflect.deleteProperty(withoutOrigin, 'originatingPromptMessageId')
    expect(matchPlanDelivery(withoutOrigin, { commandId: 'cmd-1' })).toBeUndefined()
  })

  it('honors expected state and command identity independently', () => {
    expect(
      matchPlanDelivery(plan('approved', approvedDelivery), {
        commandId: 'cmd-1',
        state: 'accepted'
      })
    ).toBeUndefined()
    expect(
      matchPlanDelivery(plan('approved', { ...approvedDelivery, state: 'accepted' }), {
        commandId: 'cmd-1',
        state: 'accepted'
      })
    ).toBeDefined()
    expect(
      matchPlanDelivery(plan('approved', approvedDelivery), { commandId: 'other' })
    ).toBeUndefined()
    expect(
      matchPlanDelivery(plan('approved', approvedDelivery), {
        commandId: 'cmd-1',
        artifactVersionId: 'replacement'
      })
    ).toBeUndefined()
  })
})

describe('adversarial SessionPlanDeliveryOwner transitions', () => {
  const createSessions = (
    delivery?: SessionPlanRuntimeContext['delivery'],
    planOverrides: Partial<SessionPlanRuntimeContext> = {}
  ): {
    sessions: SessionPlanDeliverySessions
    context: () => SessionRuntimeContext
    patch: ReturnType<typeof vi.fn<SessionPlanDeliverySessions['patchSessionRuntimeContext']>>
  } => {
    // Mirror production restore: durable reads are sanitized, so mismatched receipts never
    // survive into the delivery owner's view.
    const sanitized = sanitizeSessionRuntimeContext({
      version: 1,
      revision: 0,
      plan: {
        artifactId: 'plan-1',
        artifactVersionId: 'plan-version-1',
        artifactChecksum: 'checksum-1',
        originatingPromptMessageId: 'prompt-1',
        approval: 'approved',
        stepStatuses: {},
        ...(delivery ? { delivery } : {}),
        ...planOverrides
      }
    })
    let context: SessionRuntimeContext = sanitized ?? { version: 1, revision: 0 }
    const patch = vi.fn(async (command) => {
      if (command.expectedRevision !== context.revision) {
        throw Object.assign(new Error('revision conflict'), { code: 'revision-conflict' })
      }
      const next = sanitizeSessionRuntimeContext({
        ...context,
        ...command.patch,
        revision: context.revision + 1
      })
      if (!next) throw new Error('Session runtime context patch is not JSON-safe.')
      context = next
      return structuredClone(context)
    })
    return {
      sessions: {
        readSessionRuntimeContext: vi.fn(async () => structuredClone(context)),
        patchSessionRuntimeContext: patch
      },
      context: () => context,
      patch
    }
  }

  const queued = {
    commandId: 'delivery-1',
    kind: 'approved-plan' as const,
    state: 'queued' as const,
    originatingPromptMessageId: 'prompt-1',
    createdAt: 42
  }

  it('refuses begin after the receipt is already delivering or accepted', async () => {
    for (const state of ['delivering', 'accepted'] as const) {
      const fixture = createSessions({ ...queued, state })
      await expect(
        new SessionPlanDeliveryOwner(fixture.sessions).begin('project-1', 'session-1', 'delivery-1')
      ).resolves.toBe(false)
    }
  })

  it('refuses begin when sanitizer dropped a kind/approval mismatched receipt', async () => {
    const fixture = createSessions({
      ...queued,
      kind: 'review-feedback',
      originatingPromptMessageId: 'feedback-1'
    })
    expect(fixture.context().plan?.delivery).toBeUndefined()
    await expect(
      new SessionPlanDeliveryOwner(fixture.sessions).begin('project-1', 'session-1', 'delivery-1')
    ).resolves.toBe(false)
  })

  it('refuses accept after the Plan artifact identity changed', async () => {
    const fixture = createSessions({ ...queued, state: 'delivering' })
    fixture.sessions.patchSessionRuntimeContext = vi.fn(async (command) => {
      const plan = fixture.context().plan!
      await (Object.getPrototypeOf(fixture.sessions) as object, Promise.resolve())
      void command
      const mutated = sanitizeSessionRuntimeContext({
        ...fixture.context(),
        plan: {
          ...plan,
          artifactChecksum: 'changed-checksum',
          delivery: { ...plan.delivery!, state: 'delivering' }
        },
        revision: fixture.context().revision + 1
      })
      throw Object.assign(new Error('revision conflict'), {
        code: 'revision-conflict',
        next: mutated
      })
    }) as never
    // Replace with a CAS that mutates checksum then conflicts.
    let context = fixture.context()
    const originalPatch = fixture.patch.getMockImplementation()!
    fixture.patch.mockImplementation(async (command) => {
      const plan = context.plan!
      context = {
        ...context,
        revision: context.revision + 1,
        plan: {
          ...plan,
          artifactChecksum: 'changed-checksum'
        }
      }
      await originalPatch({
        ...command,
        expectedRevision: command.expectedRevision,
        patch: { plan: context.plan }
      }).catch(() => undefined)
      throw Object.assign(new Error('revision conflict'), { code: 'revision-conflict' })
    })
    await expect(
      new SessionPlanDeliveryOwner(fixture.sessions).accept('project-1', 'session-1', 'delivery-1')
    ).resolves.toBe(false)
  })

  it('clears accepted receipts but never clears a still-queued receipt', async () => {
    const accepted = createSessions({ ...queued, state: 'accepted' })
    await expect(
      new SessionPlanDeliveryOwner(accepted.sessions).clear('project-1', 'session-1', 'delivery-1')
    ).resolves.toBe(true)
    expect(accepted.context().plan?.delivery).toBeUndefined()

    const stillQueued = createSessions(queued)
    await expect(
      new SessionPlanDeliveryOwner(stillQueued.sessions).clear(
        'project-1',
        'session-1',
        'delivery-1'
      )
    ).resolves.toBe(false)
    expect(stillQueued.context().plan?.delivery?.state).toBe('queued')
  })

  it('interrupts accepted/delivering receipts but not queued ones', async () => {
    const delivering = createSessions({ ...queued, state: 'delivering' })
    await expect(
      new SessionPlanDeliveryOwner(delivering.sessions).interrupt(
        'project-1',
        'session-1',
        'delivery-1'
      )
    ).resolves.toBe(true)
    expect(delivering.context().plan?.delivery?.state).toBe('interrupted')

    const queuedFixture = createSessions(queued)
    await expect(
      new SessionPlanDeliveryOwner(queuedFixture.sessions).interrupt(
        'project-1',
        'session-1',
        'delivery-1'
      )
    ).resolves.toBe(false)
  })

  it('cannot rearm accepted or interrupted receipts', async () => {
    for (const state of ['accepted', 'interrupted', 'queued'] as const) {
      const fixture = createSessions({ ...queued, state })
      await expect(
        new SessionPlanDeliveryOwner(fixture.sessions).rearmUnaccepted(
          'project-1',
          'session-1',
          'delivery-1'
        )
      ).resolves.toBe(false)
    }
  })

  it('lets a sanitizer drop a mismatched review-feedback receipt without losing approval', () => {
    const sanitized = sanitizeSessionRuntimeContext({
      version: 1,
      revision: 3,
      plan: {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactChecksum: 'checksum-1',
        originatingPromptMessageId: 'prompt-1',
        approval: 'approved',
        stepStatuses: {},
        delivery: {
          commandId: 'cmd-1',
          kind: 'review-feedback',
          state: 'queued',
          originatingPromptMessageId: 'prompt-1',
          createdAt: 1
        }
      }
    })
    expect(sanitized?.plan?.approval).toBe('approved')
    expect(sanitized?.plan?.delivery).toBeUndefined()
  })

  it('maps legacy continuation receipts onto the modern delivering state', () => {
    const sanitized = sanitizeSessionRuntimeContext({
      version: 1,
      revision: 0,
      plan: {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactChecksum: 'checksum-1',
        originatingPromptMessageId: 'prompt-1',
        approval: 'approved',
        stepStatuses: {},
        continuation: {
          commandId: 'legacy-1',
          kind: 'approved-plan',
          state: 'continuing',
          originatingPromptMessageId: 'prompt-1',
          createdAt: 9
        }
      }
    })
    expect(sanitized?.plan?.delivery).toEqual({
      commandId: 'legacy-1',
      kind: 'approved-plan',
      state: 'delivering',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 9
    })
  })
})

describe('adversarial plan runtime context sanitizer', () => {
  const validPlan = {
    artifactId: 'artifact-1',
    artifactVersionId: 'version-1',
    artifactChecksum: 'checksum-1',
    originatingPromptMessageId: 'prompt-1',
    approval: 'approved',
    stepStatuses: {}
  }

  const sanitizePlan = (plan: unknown): SessionPlanRuntimeContext | undefined =>
    sanitizeSessionRuntimeContext({ version: 1, revision: 0, plan })?.plan

  it('drops unknown fields on the Plan object entirely', () => {
    expect(sanitizePlan({ ...validPlan, evil: true })).toBeUndefined()
  })

  it('rejects invalid approval, missing identity, and non-object plans', () => {
    expect(sanitizePlan({ ...validPlan, approval: 'maybe' })).toBeUndefined()
    expect(sanitizePlan({ ...validPlan, artifactChecksum: '' })).toBeUndefined()
    expect(sanitizePlan(null)).toBeUndefined()
    expect(sanitizePlan('pending')).toBeUndefined()
  })

  it('rejects corrupt documents and invalid step status payloads', () => {
    expect(sanitizePlan({ ...validPlan, document: { schema_version: 2 } })).toBeUndefined()
    expect(sanitizePlan({ ...validPlan, stepStatuses: 'all' })).toBeUndefined()
    expect(
      sanitizePlan({
        ...validPlan,
        stepStatuses: { Step: { status: 'done', updatedAt: 1 } }
      })
    ).toBeUndefined()
    expect(
      sanitizePlan({
        ...validPlan,
        stepStatuses: { Step: { status: 'completed', updatedAt: -1 } }
      })
    ).toBeUndefined()
    expect(
      sanitizePlan({
        ...validPlan,
        stepStatuses: { '': { status: 'completed', updatedAt: 1 } }
      })
    ).toBeUndefined()
  })

  it('strips reviewFeedbackMessageId after approval/rejection decisions', () => {
    const sanitized = sanitizePlan({
      ...validPlan,
      approval: 'approved',
      reviewFeedbackMessageId: 'should-not-survive',
      stepStatuses: {}
    })
    expect(sanitized?.reviewFeedbackMessageId).toBeUndefined()
  })

  it('preserves prototype-like step titles as opaque keys from JSON payloads', () => {
    // Object-literal `__proto__` is special; durable restore paths parse JSON, which creates
    // an own property. Ensure the sanitizer keeps those titles opaque.
    const sanitized = sanitizePlan(
      JSON.parse(
        '{"artifactId":"artifact-1","artifactVersionId":"version-1","artifactChecksum":"checksum-1",' +
          '"originatingPromptMessageId":"prompt-1","approval":"approved","stepStatuses":' +
          '{"__proto__":{"status":"completed","updatedAt":1},' +
          '"constructor":{"status":"in_progress","updatedAt":2},' +
          '"toString":{"status":"blocked","updatedAt":3,"notes":"blocked note"}}}'
      )
    )
    expect(sanitized?.stepStatuses).toMatchObject({
      constructor: { status: 'in_progress', updatedAt: 2 },
      toString: { status: 'blocked', updatedAt: 3, notes: 'blocked note' }
    })
    expect(Object.hasOwn(sanitized!.stepStatuses, '__proto__')).toBe(true)
    expect(
      (sanitized!.stepStatuses as Record<string, { status: string }>)['__proto__']?.status
    ).toBe('completed')
  })
})

describe('adversarial SessionPlanInteractionOwner', () => {
  it('rejects a second approval reservation while one is outstanding', () => {
    const owner = new SessionPlanInteractionOwner()
    owner.reserveApproval('session-1', 'interaction-1')
    expect(() => owner.reserveApproval('session-1', 'interaction-2')).toThrowError(PlanCommandError)
    expect(() => owner.parkApproval('session-1', 'interaction-2')).toThrowError(PlanCommandError)
  })

  it('requires the matching reservation token before parking reserved approval', () => {
    const owner = new SessionPlanInteractionOwner()
    expect(() => owner.parkReservedApproval('session-1', 'interaction-x')).toThrow(
      /reservation is no longer available/
    )
  })

  it('ignores resolveApproval with a stale or foreign token', () => {
    const owner = new SessionPlanInteractionOwner()
    const parked = owner.parkApproval('session-1', 'interaction-1')
    const token = owner.approvalTokenFor('session-1')
    expect(owner.resolveApproval('session-1', 'approved', {})).toBe(false)
    expect(owner.resolveApproval('session-1', 'approved', undefined)).toBe(false)
    expect(owner.resolveApproval('session-1', 'approved', token)).toBe(true)
    expect(owner.resolveApproval('session-1', 'approved', token)).toBe(false)
    expect(owner.rejectApproval('session-1', 'late')).toBe(false)
    void parked
  })

  it('clearSession rejects the parked waiter and disposes provider pause ownership', async () => {
    const owner = new SessionPlanInteractionOwner()
    const response = owner.parkApproval('session-1', 'interaction-1')
    const dispose = vi.fn()
    owner.suspendProvider('session-1', 7, response, () => dispose)
    expect(owner.hasPendingApproval('session-1')).toBe(true)

    owner.clearSession('session-1', 'session deleted')
    await expect(response).rejects.toThrow(/session deleted/)
    expect(dispose).toHaveBeenCalled()
    expect(owner.hasPendingApproval('session-1')).toBe(false)
    expect(owner.approvalTokenFor('session-1')).toBeUndefined()
  })

  it('clears agent decision authorization when a new Plan generation is registered', () => {
    const owner = new SessionPlanInteractionOwner()
    owner.register({ sessionId: 'session-1', artifactVersionId: 'v1', interactionId: 'i1' })
    owner.authorizeAgentDecision({
      sessionId: 'session-1',
      artifactVersionId: 'v1',
      interactionSequence: 3
    })
    expect(
      owner.isAgentDecisionAuthorized({
        sessionId: 'session-1',
        artifactVersionId: 'v1',
        interactionSequence: 3
      })
    ).toBe(true)
    owner.register({ sessionId: 'session-1', artifactVersionId: 'v2', interactionId: 'i2' })
    expect(
      owner.consumeAgentDecisionAuthorization({
        sessionId: 'session-1',
        artifactVersionId: 'v1',
        interactionSequence: 3
      })
    ).toBe(false)
  })

  it('only releases interaction identity that still matches the Plan version', () => {
    const owner = new SessionPlanInteractionOwner()
    owner.register({ sessionId: 'session-1', artifactVersionId: 'v1', interactionId: 'i1' })
    expect(owner.release('session-1', 'v0')).toBe(false)
    expect(owner.interactionIdFor('session-1', 'v0')).toBeUndefined()
    expect(owner.interactionIdFor('session-1', 'v1')).toBe('i1')
    expect(owner.release('session-1', 'v1')).toBe(true)
    expect(owner.interactionIdFor('session-1', 'v1')).toBeUndefined()
  })

  it('disposes immediately when provider stop is observed before ownership assignment completes', () => {
    const owner = new SessionPlanInteractionOwner()
    const response = owner.parkApproval('session-1', 'interaction-1')
    const dispose = vi.fn()
    owner.suspendProvider('session-1', 4, response, () => {
      owner.observeProviderStop('session-1', 4)
      return dispose
    })
    expect(dispose).toHaveBeenCalled()
    expect(owner.providerPauseFor('session-1', 4)?.stopObserved).toBe(true)
  })

  it('ignores provider-stop observations for a different interaction sequence', () => {
    const owner = new SessionPlanInteractionOwner()
    const response = owner.parkApproval('session-1', 'interaction-1')
    const dispose = vi.fn()
    owner.suspendProvider('session-1', 4, response, () => dispose)
    expect(owner.observeProviderStop('session-1', 9)).toBeUndefined()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('refuses releaseProviderPause after the pause object was already replaced', () => {
    const owner = new SessionPlanInteractionOwner()
    const response = owner.parkApproval('session-1', 'interaction-1')
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    owner.suspendProvider('session-1', 1, response, () => firstDispose)
    const firstPause = owner.providerPauseFor('session-1')!
    expect(owner.releaseProviderPause('session-1', firstPause)).toBe(true)

    owner.suspendProvider('session-1', 1, response, () => secondDispose)
    expect(owner.releaseProviderPause('session-1', firstPause)).toBe(false)
  })
})

describe('adversarial PlanService approval, feedback, and generation', () => {
  it('rejects whitespace-only feedback without persisting a user Message', async () => {
    const harness = makePlanServiceHarness()
    await generatePending(harness)
    await expect(
      harness.service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        feedback: '   \n\t '
      })
    ).rejects.toMatchObject({ code: 'invalid-plan' })
    expect(harness.dependencies.persistUserMessage).not.toHaveBeenCalled()
  })

  it('rejects feedback when the Plan is already decided', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness)
    await harness.service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: projection.revision,
      decision: 'approved'
    })
    await expect(
      harness.service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        feedback: 'revise'
      })
    ).rejects.toMatchObject({ code: 'approval-already-decided' })
  })

  it('rejects feedback once the originating interaction identity is gone', async () => {
    const harness = makePlanServiceHarness()
    await generatePending(harness)
    harness.interactions.release('session-1', 'version-1')
    await expect(
      harness.service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        feedback: 'revise'
      })
    ).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('makes approve/reject irreversible and idempotent only for the same decision', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness)
    const approved = await harness.service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: projection.revision,
      decision: 'approved'
    })
    expect(approved.changed).toBe(true)

    const again = await harness.service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: projection.revision,
      decision: 'approved'
    })
    expect(again.changed).toBe(false)

    // Contradictory decision on the current durable revision must be irreversible.
    await expect(
      harness.service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        decision: 'rejected'
      })
    ).rejects.toMatchObject({ code: 'approval-already-decided' })

    // Contradictory decision carrying the pre-approve revision is fail-closed as CAS drift.
    // Callers must refresh projection; they must not interpret this as a retryable approve path.
    await expect(
      harness.service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: projection.revision,
        decision: 'rejected'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(harness.context().plan?.approval).toBe('approved')
  })

  it('fails closed when the Plan lost its originating Message before approval delivery', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness)
    const context = harness.context()
    harness.setContext({
      ...context,
      plan: {
        ...context.plan!,
        originatingPromptMessageId: undefined as unknown as string
      }
    })
    await expect(
      harness.service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: projection.revision,
        decision: 'approved'
      })
    ).rejects.toMatchObject({ code: 'invalid-plan' })
  })

  it('blocks replacement generation while a fresh pending Plan awaits first review', async () => {
    const harness = makePlanServiceHarness()
    await generatePending(harness)
    await expect(
      harness.service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-2',
        interactionId: 'interaction-2',
        content: {
          ...baseContent,
          task_summary: 'A different objective'
        }
      })
    ).rejects.toMatchObject({ code: 'plan-review-pending' })
  })

  it('re-registers the caller when reviewed generation retries an identical pending Plan', async () => {
    const harness = makePlanServiceHarness()
    const first = await generatePending(harness)
    await harness.service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'tighten the success criteria'
    })
    const second = await generatePending(harness, baseContent, 'interaction-2')
    expect(second.artifactVersionId).toBe(first.artifactVersionId)
    expect(harness.interactions.interactionIdFor('session-1', first.artifactVersionId)).toBe(
      'interaction-2'
    )
  })

  it('does not activate a Plan when Artifact write omits provenance fields', async () => {
    const harness = makePlanServiceHarness()
    harness.dependencies.writeArtifactForExecution = vi.fn(async () => ({
      artifactId: 'artifact-1',
      name: 'plan.json'
      // missing versionId/checksum
    })) as never
    await expect(
      harness.service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content: baseContent
      })
    ).rejects.toMatchObject({ code: 'artifact-unavailable' })
    expect(harness.context().plan).toBeUndefined()
  })

  it('does not activate a Plan when durable verification checksum mismatches', async () => {
    const harness = makePlanServiceHarness()
    await generatePending(harness).catch(() => undefined)
    // Reset to empty session, then force a write/read checksum mismatch.
    harness.setContext({ version: 1, revision: 0 })
    const bytes = 'original'
    harness.dependencies.writeArtifactForExecution = vi.fn(async () => ({
      artifactId: 'artifact-1',
      versionId: 'version-1',
      checksum: sha256(bytes),
      name: 'plan.json'
    })) as never
    harness.dependencies.readArtifactVersion = vi.fn(async () => ({
      content: 'tampered',
      checksum: sha256(bytes)
    })) as never
    await expect(
      harness.service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content: baseContent
      })
    ).rejects.toMatchObject({ code: 'artifact-unavailable' })
    expect(harness.context().plan).toBeUndefined()
  })

  it('aborts a decision commit when beforeDecisionCommit revokes authorization', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness)
    const beforeRevision = harness.context().revision
    await expect(
      harness.service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: projection.revision,
        decision: 'approved',
        beforeDecisionCommit: () => false
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(harness.context().revision).toBe(beforeRevision)
    expect(harness.context().plan?.approval).toBe('pending')
  })

  it('refuses delivery re-queue when another receipt kind is already active', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness)
    await harness.service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: projection.revision,
      decision: 'approved'
    })
    await expect(
      harness.service.queueReviewFeedbackDelivery({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        feedbackMessageId: 'message-1'
      })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/interaction-mismatch|approval-already/)
    })
  })

  it('refuses review-feedback delivery when the feedback Message identity drifted', async () => {
    const harness = makePlanServiceHarness()
    await generatePending(harness)
    const feedback = await harness.service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'please revise'
    })
    expect(feedback.kind).toBe('feedback')
    // Simulate drift after a concurrent rewrite of reviewFeedbackMessageId.
    harness.setContext({
      ...harness.context(),
      plan: {
        ...harness.context().plan!,
        reviewFeedbackMessageId: 'other-message'
      }
    })
    await expect(
      harness.service.queueReviewFeedbackDelivery({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: feedback.artifactVersionId,
        expectedRevision: harness.context().revision,
        feedbackMessageId: 'message-1'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
  })

  it('refuses discard once the Plan Artifact becomes readable again', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness)
    await expect(
      harness.service.discardUnavailable({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: projection.revision
      })
    ).rejects.toMatchObject({ code: 'invalid-plan' })
    expect(harness.context().plan?.approval).toBe('pending')
  })

  it('discards only when the durable Plan Artifact is truly unreadable', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness)
    harness.dependencies.readArtifactVersion = vi.fn(async () => {
      throw new Error('gone')
    }) as never
    // Embedded document still short-circuits artifact reads; force document-less legacy path.
    harness.setContext({
      ...harness.context(),
      plan: {
        ...harness.context().plan!,
        document: undefined as unknown as PlanDocumentV1
      }
    })
    const revision = harness.context().revision
    const result = await harness.service.discardUnavailable({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: revision
    })
    expect(result.revision).toBeGreaterThan(revision)
    expect(harness.context().plan).toBeUndefined()
    expect(projection.approval).toBe('pending')
  })

  it('reports delivery context only for the exact durable receipt command', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness)
    const approved = await harness.service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: projection.revision,
      decision: 'approved'
    })
    await expect(
      harness.service.getDeliveryContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        commandId: approved.deliveryCommandId!
      })
    ).resolves.toMatchObject({ delivery: expect.objectContaining({ kind: 'approved-plan' }) })
    await expect(
      harness.service.getDeliveryContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        commandId: 'not-the-command'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
  })
})

describe('adversarial PlanService step progress and dependency gates', () => {
  const approveMulti = async (): Promise<{
    harness: ReturnType<typeof makePlanServiceHarness>
    artifactVersionId: string
    revision: number
  }> => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness, multiDelegationContent)
    const approved = await harness.service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: projection.revision,
      decision: 'approved'
    })
    return {
      harness,
      artifactVersionId,
      revision: approved.projection.revision
    }
  }

  it('rejects progress updates while the Plan is not approved', async () => {
    const harness = makePlanServiceHarness()
    const { artifactVersionId, projection } = await generatePending(harness, multiDelegationContent)
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: projection.revision,
        title: 'A1',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'plan-not-approved' })
  })

  it('rejects unknown steps and illegal transitions', async () => {
    const { harness, artifactVersionId } = await approveMulti()
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title: 'Missing step',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'unknown-step' })

    await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'A1',
      status: 'in_progress'
    })
    await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'A1',
      status: 'completed'
    })
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title: 'A1',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'invalid-transition' })

    // First transition cannot jump to a terminal status.
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title: 'B1',
        status: 'completed'
      })
    ).rejects.toMatchObject({ code: 'invalid-transition' })
  })

  it('treats skipped and blocked as terminal and blocks reopening them', async () => {
    const { harness, artifactVersionId } = await approveMulti()
    await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'B1',
      status: 'skipped'
    })
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title: 'B1',
        status: 'completed'
      })
    ).rejects.toMatchObject({ code: 'invalid-transition' })
  })

  it('blocks starting a later step and a new delegation while a dependency or Plan block exists', async () => {
    const { harness, artifactVersionId } = await approveMulti()
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title: 'A2',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })

    await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'A1',
      status: 'in_progress'
    })
    await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'A1',
      status: 'blocked'
    })
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title: 'B1',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })
  })

  it('enforces phase gates before synthesis can start', async () => {
    const { harness, artifactVersionId } = await approveMulti()
    for (const title of ['A1', 'A2', 'B1']) {
      await harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title,
        status: 'in_progress'
      })
      await harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title,
        status: 'completed'
      })
    }
    const synthesis = await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'C1',
      status: 'in_progress'
    })
    expect(synthesis.projection.lifecycle).toBe('in_progress')
  })

  it('clears delivery only when the Plan reaches a terminal blocked/completed outcome', async () => {
    const { harness, artifactVersionId } = await approveMulti()
    expect(harness.context().plan?.delivery?.kind).toBe('approved-plan')

    const update = async (
      title: string,
      status: 'in_progress' | 'completed' | 'blocked' | 'skipped'
    ): ReturnType<typeof harness.service.updateStepStatus> =>
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title,
        status
      })

    await update('A1', 'in_progress')
    expect(harness.context().plan?.delivery).toBeDefined()

    // Blocking A1 while no other step is in_progress/not_started projects remaining work as
    // not_run and makes the Plan a terminal blocked outcome — delivery is cleared immediately.
    await update('A1', 'blocked')
    expect(
      isPlanTerminalOutcome(
        createPlanDocumentV1(multiDelegationContent),
        harness.context().plan!.stepStatuses
      )
    ).toBe(true)
    expect(harness.context().plan?.delivery).toBeUndefined()
  })

  it('keeps delivery while peer work remains active after a local block', async () => {
    const { harness, artifactVersionId } = await approveMulti()
    const update = async (
      title: string,
      status: 'in_progress' | 'completed' | 'blocked' | 'skipped'
    ): ReturnType<typeof harness.service.updateStepStatus> =>
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title,
        status
      })

    await update('A1', 'in_progress')
    await update('B1', 'in_progress')
    await update('A1', 'blocked')
    // Peer B1 is still in_progress → not a terminal Plan outcome; delivery must remain.
    expect(harness.context().plan?.delivery).toBeDefined()

    await update('B1', 'completed')
    // Now only blocked/not_run remain → terminal; delivery clears.
    expect(
      isPlanTerminalOutcome(
        createPlanDocumentV1(multiDelegationContent),
        harness.context().plan!.stepStatuses
      )
    ).toBe(true)
    expect(harness.context().plan?.delivery).toBeUndefined()
  })

  it('keeps same-terminal status idempotent and rejects concurrent revision drift', async () => {
    const { harness, artifactVersionId } = await approveMulti()
    await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'A1',
      status: 'in_progress'
    })
    await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'A1',
      status: 'completed'
    })
    const repeat = await harness.service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId,
      expectedRevision: harness.context().revision,
      title: 'A1',
      status: 'completed'
    })
    expect(repeat.changed).toBe(false)

    // Concurrent durable rewrite that drops the terminal status while bumping revision must
    // fail closed as CAS drift — callers refresh, they do not re-complete blindly.
    harness.setContext({
      version: 1,
      revision: harness.context().revision + 1,
      plan: {
        ...harness.context().plan!,
        stepStatuses: {}
      }
    })
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision - 1,
        title: 'A1',
        status: 'completed'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })

    // Same-revision status wipe is not a CAS conflict; it is an illegal transition.
    harness.setContext({
      version: 1,
      revision: harness.context().revision,
      plan: {
        ...harness.context().plan!,
        stepStatuses: {}
      }
    })
    await expect(
      harness.service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId,
        expectedRevision: harness.context().revision,
        title: 'A1',
        status: 'completed'
      })
    ).rejects.toMatchObject({ code: 'invalid-transition' })
  })
})

describe('adversarial Plan document contract edges', () => {
  it('rejects malformed documents before any Artifact write', () => {
    expect(() => createPlanDocumentV1(null)).toThrow(PlanCommandError)
    expect(() => createPlanDocumentV1({ ...baseContent, phases: [] })).toThrow(/at least one phase/)
    expect(() =>
      createPlanDocumentV1({
        ...baseContent,
        phases: [{ name: 'P', delegations: [{ name: 'D', steps: [] }] }]
      })
    ).toThrow(/at least one step/)
    expect(() => createPlanDocumentV1({ ...baseContent, schema_version: 2 })).toThrow(
      /schema_version must be 1/
    )
    expect(() =>
      createPlanDocumentV1({
        ...baseContent,
        feasibility: { confidence: 'certain', rationale: 'ok' }
      })
    ).toThrow(/confidence is invalid/)
    expect(() => createPlanDocumentV1({ ...baseContent, task_summary: '  ' })).toThrow(
      /task_summary must be non-empty/
    )
    expect(() => createPlanDocumentV1({ ...baseContent, desired_outputs: 'report' })).toThrow(
      /desired_outputs must be an array/
    )
  })

  it('rejects duplicate step titles across phases and delegations', () => {
    expect(() =>
      createPlanDocumentV1({
        ...baseContent,
        phases: [
          {
            name: 'P1',
            delegations: [{ name: 'D1', steps: [{ title: 'Same', description: 'a' }] }]
          },
          {
            name: 'P2',
            delegations: [{ name: 'D2', steps: [{ title: 'Same', description: 'b' }] }]
          }
        ]
      })
    ).toThrow(/Duplicate step title/)
  })

  it('rejects oversized Plans that cannot track every step status', () => {
    const steps = Array.from({ length: 800 }, (_, index) => ({
      title: `Step ${index}`,
      description: 'work'
    }))
    const document = createPlanDocumentV1({
      ...baseContent,
      phases: [{ name: 'Big', delegations: [{ name: 'All', steps }] }]
    })
    expect(planStepTitles(document)).toHaveLength(800)
    expect(() => assertPlanDocumentCapacity(document)).toThrow(/too large/)
  })

  it('projects blocked/unreachable step states and protected-context wording by approval', () => {
    const document = createPlanDocumentV1(multiDelegationContent)
    const statuses = {
      A1: { status: 'blocked' as const, updatedAt: 42, notes: ' waiting on credentials ' },
      A2: { status: 'in_progress' as const, updatedAt: 42 },
      B1: { status: 'completed' as const, updatedAt: 42 }
    }
    const states = projectPlanStepStates(document, statuses)
    expect(states.A1).toEqual({ status: 'blocked', notes: ' waiting on credentials ' })
    expect(states.C1?.status).toBe('not_run')
    expect(derivePlanLifecycle(document, 'approved', statuses)).toBe('in_progress')

    const projection: ActivePlanProjection = {
      artifactId: 'artifact-1',
      artifactVersionId: 'version-1',
      artifactChecksum: 'checksum-1',
      originatingPromptMessageId: 'prompt-1',
      revision: 2,
      approval: 'approved',
      lifecycle: 'in_progress',
      document,
      stepStatuses: statuses,
      stepStates: states,
      counts: { phases: 2, delegations: 3, steps: 4, completed: 1, inProgress: 1 }
    }
    const approvedContext = formatPlanProtectedContext(projection)
    expect(approvedContext).toContain('approval=approved lifecycle=in_progress')
    expect(approvedContext).toContain('Use this approved Session Plan as durable work context')
    expect(approvedContext).toContain('A1: blocked')
    expect(
      formatPlanProtectedContext({
        ...projection,
        approval: 'pending',
        lifecycle: 'awaiting_approval'
      })
    ).toContain('pending review, not approved execution context')
    expect(
      formatPlanProtectedContext({ ...projection, approval: 'rejected', lifecycle: 'rejected' })
    ).toContain('was rejected')
    expect(
      formatPlanProtectedContext(projection, {
        kind: 'file-unavailable',
        warning: 'Plan file missing'
      })
    ).toContain('Plan file missing')
  })
})
