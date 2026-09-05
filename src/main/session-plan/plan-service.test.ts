import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { SessionRuntimeContext } from '../../shared/session-persistence'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { PlanService, type PlanServiceDependencies } from './plan-service'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'

const content = {
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

const executionContent = {
  ...content,
  phases: [
    {
      name: 'Parallel analysis',
      delegations: [
        {
          name: 'Cohort comparison',
          steps: [
            { title: 'Validate cohorts', description: 'Confirm cohort boundaries.' },
            { title: 'Compare cohorts', description: 'Calculate cohort differences.' }
          ]
        },
        {
          name: 'Evidence review',
          steps: [
            { title: 'Find evidence', description: 'Find supporting evidence.' },
            { title: 'Review evidence', description: 'Review supporting evidence.' }
          ]
        },
        {
          name: 'Quality review',
          steps: [{ title: 'Audit findings', description: 'Audit the analysis findings.' }]
        }
      ]
    },
    {
      name: 'Synthesis',
      delegations: [
        {
          name: 'Report',
          steps: [{ title: 'Draft report', description: 'Produce the final report.' }]
        }
      ]
    }
  ]
}

type PlanServiceHarness = Readonly<{
  service: PlanService
  interactions: SessionPlanInteractionOwner
  dependencies: PlanServiceDependencies
  context: () => SessionRuntimeContext
  status: () => string
  setContext: (next: SessionRuntimeContext) => void
}>

const setup = (): PlanServiceHarness => {
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  let persistedStatus = 'running'
  let bytes = ''
  const interactions = new SessionPlanInteractionOwner()
  const dependencies: PlanServiceDependencies = {
    interactions,
    writeArtifactForExecution: vi.fn(async (_executionId, input) => {
      bytes = input.content
      return {
        artifactId: 'artifact-1',
        versionId: 'version-1',
        checksum: createHash('sha256').update(bytes).digest('hex'),
        name: input.filename
      }
    }),
    readArtifactVersion: vi.fn(async () => ({
      content: bytes,
      checksum: createHash('sha256').update(bytes).digest('hex')
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
      persistedStatus = sessionStatus
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
      .mockReturnValueOnce('delivery-2'),
    onApprovalRequested: vi.fn(),
    onApprovalSettled: vi.fn()
  }
  return {
    service: new PlanService(dependencies),
    interactions,
    dependencies,
    context: () => context,
    status: () => persistedStatus,
    setContext: (next) => {
      context = next
    }
  }
}

type ExecutionPlanFixture = Readonly<{
  service: PlanService
  identity: Readonly<{
    projectId: string
    sessionId: string
    artifactVersionId: string
  }>
  generated: Awaited<ReturnType<PlanService['generate']>>
}>

const generateExecutionPlan = async (): Promise<ExecutionPlanFixture> => {
  const { service } = setup()
  const generated = await service.generate({
    projectId: 'project-1',
    sessionId: 'session-1',
    executionId: 'execution-1',
    interactionId: 'interaction-1',
    content: executionContent
  })
  return {
    service,
    generated,
    identity: {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
  }
}

const approveExecutionPlan = async (): Promise<
  ExecutionPlanFixture &
    Readonly<{ approved: { projection: ActivePlanProjection; changed: boolean } }>
> => {
  const fixture = await generateExecutionPlan()
  const approved = await fixture.service.respond({
    ...fixture.identity,
    expectedRevision: fixture.generated.projection.revision,
    decision: 'approved'
  })
  return { ...fixture, approved }
}

describe('PlanService', () => {
  it('durably verifies a generated Plan before atomically activating it for the Session', async () => {
    const { service, dependencies, context, status } = setup()

    const result = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })

    expect(dependencies.writeArtifactForExecution).toHaveBeenCalledWith(
      'execution-1',
      expect.objectContaining({
        filename: 'plan-a91f30c2.json',
        mimeType: 'application/json',
        kind: 'plan'
      })
    )
    expect(dependencies.readArtifactVersion).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      artifactVersionId: 'version-1'
    })
    expect(context().plan).toMatchObject({
      artifactId: 'artifact-1',
      artifactVersionId: 'version-1',
      originatingPromptMessageId: 'interaction-1',
      materializedAt: 42,
      document: { schema_version: 1, task_summary: content.task_summary },
      approval: 'pending',
      stepStatuses: {}
    })
    expect(status()).toBe('waiting-plan-approval')
    expect(result.projection.lifecycle).toBe('awaiting_approval')
    expect(result.projection.originatingPromptMessageId).toBe('interaction-1')
    expect(result.projection.materializedAt).toBe(42)
    expect(result.pauseInteraction).toBe(true)
    expect(dependencies.onApprovalRequested).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      summary: content.task_summary
    })
  })

  it('reconstructs a pending Plan after the unpublished Artifact reader is lost on restart', async () => {
    const { service, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    vi.mocked(dependencies.readArtifactVersion).mockRejectedValue(
      new Error('unpublished Artifact index was process-local')
    )

    const restarted = new PlanService({
      ...dependencies,
      interactions: new SessionPlanInteractionOwner()
    })

    await expect(restarted.getProjection('project-1', 'session-1')).resolves.toMatchObject({
      artifactVersionId: generated.projection.artifactVersionId,
      approval: 'pending',
      lifecycle: 'awaiting_approval',
      document: { schema_version: 1, task_summary: content.task_summary }
    })
  })

  it('forwards the final projection of the replaced Plan when generating its successor', async () => {
    const { service, dependencies, setContext } = setup()
    const document = {
      schema_version: 1 as const,
      ...content
    }
    const serialized = JSON.stringify(document, null, 2)
    setContext({
      version: 1,
      revision: 7,
      plan: {
        artifactId: 'artifact-old',
        artifactVersionId: 'version-old',
        artifactChecksum: createHash('sha256').update(serialized).digest('hex'),
        document,
        originatingPromptMessageId: 'interaction-old',
        materializedAt: 21,
        approval: 'approved',
        stepStatuses: {
          'Analyze the data': { status: 'completed', notes: 'Final result.', updatedAt: 41 }
        }
      }
    })

    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-2',
      interactionId: 'interaction-2',
      content: { ...content, task_summary: 'Analyze the follow-up dataset' }
    })

    expect(dependencies.patchRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 7,
        archivePlanProjection: {
          artifactId: 'artifact-old',
          artifactVersionId: 'version-old',
          artifactChecksum: createHash('sha256').update(serialized).digest('hex'),
          originatingPromptMessageId: 'interaction-old',
          materializedAt: 21,
          revision: 7,
          approval: 'approved',
          lifecycle: 'completed',
          document,
          stepStatuses: {
            'Analyze the data': { status: 'completed', notes: 'Final result.', updatedAt: 41 }
          },
          stepStates: {
            'Analyze the data': { status: 'completed', notes: 'Final result.' }
          },
          counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 }
        }
      })
    )
  })

  it('still generates a successor when the replaced legacy Plan Artifact is unavailable', async () => {
    const { service, dependencies, setContext } = setup()
    setContext({
      version: 1,
      revision: 7,
      plan: {
        artifactId: 'artifact-old',
        artifactVersionId: 'version-old',
        artifactChecksum: 'a'.repeat(64),
        originatingPromptMessageId: 'interaction-old',
        approval: 'approved',
        stepStatuses: {}
      }
    })
    vi.mocked(dependencies.readArtifactVersion).mockImplementation(async (request) => {
      if (request.artifactVersionId === 'version-old') throw new Error('Artifact was pruned')
      const successor = JSON.stringify(
        { schema_version: 1, ...content, task_summary: 'Analyze the follow-up dataset' },
        null,
        2
      )
      return { content: successor, checksum: createHash('sha256').update(successor).digest('hex') }
    })

    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-2',
        interactionId: 'interaction-2',
        content: { ...content, task_summary: 'Analyze the follow-up dataset' }
      })
    ).resolves.toMatchObject({ projection: { artifactVersionId: 'version-1' } })

    expect(dependencies.patchRuntimeContext).toHaveBeenCalledWith(
      expect.not.objectContaining({ archivePlanProjection: expect.anything() })
    )
  })

  it('uses one irreversible idempotent transition for approval and completes the exact step', async () => {
    const { service, context, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision
    }

    const approved = await service.respond({ ...identity, decision: 'approved' })
    expect(approved.changed).toBe(true)
    expect(dependencies.onApprovalSettled).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      state: 'resolved'
    })
    const duplicate = await service.respond({
      ...identity,
      expectedRevision: approved.projection.revision,
      decision: 'approved'
    })
    expect(duplicate.changed).toBe(false)

    const running = await service.updateStepStatus({
      ...identity,
      expectedRevision: approved.projection.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })
    expect(running.projection.lifecycle).toBe('in_progress')
    const completed = await service.updateStepStatus({
      ...identity,
      expectedRevision: running.projection.revision,
      title: 'Analyze the data',
      status: 'completed'
    })
    expect(completed.projection.lifecycle).toBe('completed')
    expect(context().plan?.stepStatuses['Analyze the data']).toMatchObject({
      status: 'completed',
      updatedAt: 42
    })
    await expect(
      service.respond({
        ...identity,
        expectedRevision: completed.projection.revision,
        decision: 'rejected'
      })
    ).rejects.toMatchObject({ code: 'approval-already-decided' })
  })

  it('rejects an authorized step update when the Plan revision changes before commit', async () => {
    const { service, context, setContext, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    vi.mocked(dependencies.readRuntimeContext).mockClear()
    vi.mocked(dependencies.readArtifactVersion).mockClear()
    vi.mocked(dependencies.patchRuntimeContext).mockClear()

    await expect(
      service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        title: 'Analyze the data',
        status: 'in_progress',
        authorizeUpdate: (projection) => {
          expect(projection.revision).toBe(approved.projection.revision)
          setContext({ ...context(), revision: context().revision + 1 })
        }
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })

    expect(dependencies.readRuntimeContext).toHaveBeenCalledOnce()
    expect(dependencies.readArtifactVersion).not.toHaveBeenCalled()
    expect(dependencies.patchRuntimeContext).toHaveBeenCalledOnce()
    expect(context().plan?.stepStatuses).toEqual({})
  })

  it('does not persist a Plan decision when its commit precondition is revoked', async () => {
    const { service, context, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    vi.mocked(dependencies.patchRuntimeContext).mockClear()

    await expect(
      service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: generated.projection.revision,
        decision: 'approved',
        beforeDecisionCommit: () => false
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })

    expect(dependencies.patchRuntimeContext).toHaveBeenCalledOnce()
    expect(dependencies.patchRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({ beforePersist: expect.any(Function) })
    )
    expect(context().plan?.approval).toBe('pending')
    expect(context().plan).not.toHaveProperty('delivery')
  })

  it.each(['approved', 'rejected'] as const)(
    'releases the live interaction after a %s decision',
    async (decision) => {
      const { service, interactions } = setup()
      const generated = await service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content
      })

      await service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: generated.projection.revision,
        decision
      })

      expect(
        interactions.interactionIdFor('session-1', generated.projection.artifactVersionId)
      ).toBeUndefined()
    }
  )

  it('counts a deliberately skipped step as done in completed Plan progress', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const skipped = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: (
        await service.respond({
          projectId: 'project-1',
          sessionId: 'session-1',
          artifactVersionId: generated.projection.artifactVersionId,
          expectedRevision: generated.projection.revision,
          decision: 'approved'
        })
      ).projection.revision,
      title: 'Analyze the data',
      status: 'skipped',
      notes: 'The input already contains the result.'
    })

    expect(skipped.projection).toMatchObject({
      lifecycle: 'completed',
      counts: { completed: 1, steps: 1 }
    })
  })

  it('treats special JavaScript property names as opaque Plan step titles', async () => {
    const { service, context } = setup()
    const specialContent = {
      ...content,
      phases: [
        {
          name: 'Special names',
          delegations: [
            {
              name: 'Primary agent',
              steps: ['toString', 'constructor', '__proto__'].map((title) => ({
                title,
                description: `Complete ${title}.`
              }))
            }
          ]
        }
      ]
    }
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content: specialContent
    })
    expect(generated.projection.stepStates).toEqual(
      Object.fromEntries(
        ['toString', 'constructor', '__proto__'].map((title) => [title, { status: 'not_started' }])
      )
    )
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    let revision = approved.projection.revision
    for (const title of ['toString', 'constructor', '__proto__']) {
      const running = await service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: revision,
        title,
        status: 'in_progress'
      })
      const completed = await service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: running.projection.revision,
        title,
        status: 'completed'
      })
      revision = completed.projection.revision
    }

    const statuses = context().plan?.stepStatuses
    expect(statuses?.toString).toMatchObject({ status: 'completed' })
    expect(statuses?.constructor).toMatchObject({ status: 'completed' })
    expect(Object.hasOwn(statuses!, '__proto__')).toBe(true)
    expect(statuses?.__proto__).toMatchObject({ status: 'completed' })
  })

  it('accepts duplicate terminal delivery with the original revision without rewriting the record', async () => {
    const { service, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    const running = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: approved.projection.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })
    const terminalCommand = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: running.projection.revision,
      title: 'Analyze the data',
      status: 'completed' as const
    }
    const completed = await service.updateStepStatus(terminalCommand)
    const revisionAfterCompletion = context().revision

    await expect(service.updateStepStatus(terminalCommand)).resolves.toMatchObject({
      changed: false,
      projection: { revision: completed.projection.revision, lifecycle: 'completed' }
    })
    expect(context().revision).toBe(revisionAfterCompletion)
  })

  it('retries in-progress work and rejects every transition away from a terminal status', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const approved = await service.respond({
      ...identity,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    const running = await service.updateStepStatus({
      ...identity,
      expectedRevision: approved.projection.revision,
      title: 'Analyze the data',
      status: 'in_progress',
      notes: 'First attempt.'
    })
    const retried = await service.updateStepStatus({
      ...identity,
      expectedRevision: running.projection.revision,
      title: 'Analyze the data',
      status: 'in_progress',
      notes: 'Retry after interruption.'
    })
    expect(retried.projection.stepStatuses['Analyze the data']).toMatchObject({
      status: 'in_progress',
      notes: 'Retry after interruption.'
    })
    const completed = await service.updateStepStatus({
      ...identity,
      expectedRevision: retried.projection.revision,
      title: 'Analyze the data',
      status: 'completed'
    })

    for (const status of ['in_progress', 'blocked', 'skipped'] as const) {
      await expect(
        service.updateStepStatus({
          ...identity,
          expectedRevision: completed.projection.revision,
          title: 'Analyze the data',
          status
        })
      ).rejects.toMatchObject({ code: 'invalid-transition' })
    }
  })

  it('rejects irreversibly, releases the Session block, and treats duplicate delivery as idempotent', async () => {
    const { service, context, dependencies, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision
    }

    const rejected = await service.respond({ ...identity, decision: 'rejected' })
    expect(rejected).toMatchObject({ changed: true, projection: { lifecycle: 'rejected' } })
    expect(status()).toBe('idle')
    expect(context().plan?.approval).toBe('rejected')
    expect(dependencies.onApprovalSettled).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      state: 'rejected'
    })

    const duplicate = await service.respond({ ...identity, decision: 'rejected' })
    expect(duplicate.changed).toBe(false)
    await expect(
      service.respond({
        ...identity,
        expectedRevision: rejected.projection.revision,
        decision: 'approved'
      })
    ).rejects.toMatchObject({ code: 'approval-already-decided' })
  })

  it('returns a live rejected interaction to running until the agent turn actually ends', async () => {
    const { service, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })

    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'rejected',
      interactionIsLive: true
    })

    expect(status()).toBe('running')
  })

  it('persists revision feedback as a standard user Message for the live blocked interaction', async () => {
    const { service, dependencies, interactions, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    expect(interactions.interactionIdFor('session-1', generated.projection.artifactVersionId)).toBe(
      'interaction-1'
    )

    const response = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    })

    expect(response).toMatchObject({
      kind: 'feedback',
      routeToInteractionId: 'interaction-1',
      text: 'Split the analysis by cohort.',
      message: { role: 'user', content: 'Split the analysis by cohort.' }
    })
    expect(dependencies.persistUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        content: 'Split the analysis by cohort.',
        interactionId: 'interaction-1'
      })
    )
    expect(
      interactions.interactionIdFor('session-1', generated.projection.artifactVersionId)
    ).toBeUndefined()
    expect(context().plan).toMatchObject({
      approval: 'pending',
      reviewFeedbackMessageId: 'message-1'
    })
  })

  it('keeps feedback neutral so a later Agent approval succeeds and clears review state', async () => {
    const { service, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: '批准执行'
    })
    const queuedFeedback = await service.queueReviewFeedbackDelivery({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: context().revision,
      feedbackMessageId: 'message-1'
    })
    expect(queuedFeedback).toMatchObject({
      changed: false,
      deliveryCommandId: 'delivery-1'
    })

    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: context().revision,
      decision: 'approved',
      interactionIsLive: true
    })

    expect(approved.projection.approval).toBe('approved')
    expect(context().plan).not.toHaveProperty('reviewFeedbackMessageId')
    expect(context().plan?.delivery).toMatchObject({
      kind: 'approved-plan',
      state: 'queued'
    })
  })

  it('allows a revised Plan only after durable review feedback', async () => {
    const { service, context, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })

    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content: { ...content, task_summary: 'Analyze by cohort' }
      })
    ).rejects.toMatchObject({ code: 'plan-review-pending' })
    expect(dependencies.writeArtifactForExecution).toHaveBeenCalledOnce()

    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    })
    await service.queueReviewFeedbackDelivery({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: context().revision,
      feedbackMessageId: 'message-1'
    })
    const revised = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content: { ...content, task_summary: 'Analyze by cohort' }
    })

    expect(revised.projection).toMatchObject({
      approval: 'pending',
      document: { task_summary: 'Analyze by cohort' }
    })
    expect(context().plan).not.toHaveProperty('reviewFeedbackMessageId')
    expect(context().plan).not.toHaveProperty('delivery')
  })

  it('registers the current interaction when reviewed generation retries an identical Plan', async () => {
    const { service, interactions } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Keep the Plan as written.'
    })

    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-2',
      content
    })

    expect(interactions.interactionIdFor('session-1', generated.projection.artifactVersionId)).toBe(
      'interaction-2'
    )
  })

  it.each(['approved', 'rejected'] as const)(
    'fails closed when detached %s lacks the originating Message identity',
    async (decision) => {
      const { service, context, setContext } = setup()
      const generated = await service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content
      })
      const plan = context().plan!
      const withoutOrigin = { ...plan }
      Reflect.deleteProperty(withoutOrigin, 'originatingPromptMessageId')
      setContext({ ...context(), plan: withoutOrigin })

      await expect(
        service.respond({
          projectId: 'project-1',
          sessionId: 'session-1',
          artifactVersionId: generated.projection.artifactVersionId,
          expectedRevision: context().revision,
          decision,
          interactionIsLive: false
        })
      ).rejects.toMatchObject({ code: 'invalid-plan' })
      expect(context().plan).toMatchObject({ approval: 'pending' })
      expect(context().plan).not.toHaveProperty('delivery')
    }
  )

  it('retains the live interaction when revision feedback persistence fails', async () => {
    const { service, dependencies, interactions } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    vi.mocked(dependencies.persistUserMessage).mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(
      service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        feedback: 'Split the analysis by cohort.'
      })
    ).rejects.toThrow('disk unavailable')
    expect(interactions.interactionIdFor('session-1', generated.projection.artifactVersionId)).toBe(
      'interaction-1'
    )
  })

  it('keeps retained in-progress work active after the Attempt ends', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    const running = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: approved.projection.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })

    expect(running.projection.lifecycle).toBe('in_progress')
    await expect(service.getProjection('project-1', 'session-1')).resolves.toMatchObject({
      lifecycle: 'in_progress'
    })
  })

  it('does not change the active Plan when durable Artifact verification fails', async () => {
    const { service, dependencies, context } = setup()
    vi.mocked(dependencies.readArtifactVersion).mockResolvedValueOnce({
      content: '{"corrupt":true}',
      checksum: 'b'.repeat(64)
    })

    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content
      })
    ).rejects.toMatchObject({ code: 'artifact-unavailable' })
    expect(context().plan).toBeUndefined()
    expect(dependencies.patchRuntimeContext).not.toHaveBeenCalled()
  })

  it('returns invalid-plan without writing an Artifact or replacing the active Plan', async () => {
    const { service, dependencies, context } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const activePlan = context().plan
    vi.mocked(dependencies.writeArtifactForExecution).mockClear()
    vi.mocked(dependencies.patchRuntimeContext).mockClear()

    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-2',
        content: {
          ...content,
          phases: [
            {
              name: 'Analysis',
              delegations: [
                {
                  name: 'Primary agent',
                  steps: [
                    { title: 'Analyze the data', description: 'First.' },
                    { title: ' Analyze the data ', description: 'Duplicate.' }
                  ]
                }
              ]
            }
          ]
        }
      })
    ).rejects.toMatchObject({ code: 'invalid-plan' })
    expect(dependencies.writeArtifactForExecution).not.toHaveBeenCalled()
    expect(dependencies.patchRuntimeContext).not.toHaveBeenCalled()
    expect(context().plan).toBe(activePlan)
  })

  it('distinguishes a CAS conflict from an unrelated persistence failure', async () => {
    const conflict = setup()
    vi.mocked(conflict.dependencies.patchRuntimeContext).mockRejectedValueOnce(
      new Error('revision conflict')
    )
    await expect(
      conflict.service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })

    const storage = setup()
    vi.mocked(storage.dependencies.patchRuntimeContext).mockRejectedValueOnce(
      new Error('disk unavailable')
    )
    await expect(
      storage.service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content
      })
    ).rejects.toThrow('disk unavailable')
  })

  it('rehydrates approved Plan state and rejects a replaced Artifact Version', async () => {
    const { service, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    const reconstructed = new PlanService({
      ...dependencies,
      interactions: new SessionPlanInteractionOwner()
    })
    await expect(
      reconstructed.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: approved.projection.revision,
        title: 'Analyze the data',
        status: 'in_progress'
      })
    ).resolves.toMatchObject({ projection: { lifecycle: 'in_progress' } })
    await expect(reconstructed.getProjection('project-1', 'session-1')).resolves.toMatchObject({
      lifecycle: 'in_progress'
    })
    vi.mocked(dependencies.writeArtifactForExecution).mockResolvedValueOnce({
      artifactId: 'artifact-2',
      versionId: 'version-2',
      checksum: generated.projection.artifactChecksum,
      name: 'plan-replacement.json'
    })
    const replacement = await reconstructed.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-2',
      content
    })
    expect(replacement.projection).toMatchObject({
      artifactId: 'artifact-2',
      artifactVersionId: 'version-2',
      approval: 'pending',
      stepStatuses: {},
      lifecycle: 'awaiting_approval'
    })
    await expect(
      reconstructed.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: replacement.projection.revision,
        title: 'Analyze the data',
        status: 'completed'
      })
    ).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('enforces serial steps and phase gates while independent delegations may start together', async () => {
    const { service, identity, approved } = await approveExecutionPlan()

    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: approved.projection.revision,
        title: 'Compare cohorts',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })
    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: approved.projection.revision,
        title: 'Compare cohorts',
        status: 'skipped'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })

    const cohortRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: approved.projection.revision,
      title: 'Validate cohorts',
      status: 'in_progress'
    })
    const evidenceRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: cohortRunning.projection.revision,
      title: 'Find evidence',
      status: 'in_progress'
    })
    expect(evidenceRunning.projection.stepStatuses).toMatchObject({
      'Validate cohorts': { status: 'in_progress' },
      'Find evidence': { status: 'in_progress' }
    })

    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: evidenceRunning.projection.revision,
        title: 'Draft report',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })
  })

  it('lets an already-started peer delegation settle after a block and then completes cleanly blocked', async () => {
    const { service, identity, approved } = await approveExecutionPlan()
    const cohortRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: approved.projection.revision,
      title: 'Validate cohorts',
      status: 'in_progress'
    })
    const evidenceRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: cohortRunning.projection.revision,
      title: 'Find evidence',
      status: 'in_progress'
    })
    const cohortBlocked = await service.updateStepStatus({
      ...identity,
      expectedRevision: evidenceRunning.projection.revision,
      title: 'Validate cohorts',
      status: 'blocked',
      notes: 'Cohort boundaries are missing.'
    })
    expect(cohortBlocked.projection.stepStates).toMatchObject({
      'Compare cohorts': { status: 'not_run' },
      'Review evidence': { status: 'not_started' },
      'Audit findings': { status: 'not_run' },
      'Draft report': { status: 'not_run' }
    })

    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: cohortBlocked.projection.revision,
        title: 'Audit findings',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })

    const evidenceFound = await service.updateStepStatus({
      ...identity,
      expectedRevision: cohortBlocked.projection.revision,
      title: 'Find evidence',
      status: 'completed'
    })
    const reviewRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: evidenceFound.projection.revision,
      title: 'Review evidence',
      status: 'in_progress'
    })
    const settled = await service.updateStepStatus({
      ...identity,
      expectedRevision: reviewRunning.projection.revision,
      title: 'Review evidence',
      status: 'completed'
    })

    expect(settled.projection.lifecycle).toBe('blocked')
    expect(settled.projection.stepStates).toMatchObject({
      'Validate cohorts': { status: 'blocked', notes: 'Cohort boundaries are missing.' },
      'Compare cohorts': { status: 'not_run' },
      'Find evidence': { status: 'completed' },
      'Review evidence': { status: 'completed' },
      'Audit findings': { status: 'not_run' },
      'Draft report': { status: 'not_run' }
    })
  })

  it('supports primary-agent sequential fallback without changing the delegation schema', async () => {
    const { service, identity, approved } = await approveExecutionPlan()
    let revision = approved.projection.revision
    const transition = async (
      title: string,
      status: 'in_progress' | 'completed'
    ): Promise<void> => {
      const result = await service.updateStepStatus({
        ...identity,
        expectedRevision: revision,
        title,
        status
      })
      revision = result.projection.revision
    }

    for (const title of [
      'Validate cohorts',
      'Compare cohorts',
      'Find evidence',
      'Review evidence',
      'Audit findings'
    ]) {
      await transition(title, 'in_progress')
      await transition(title, 'completed')
    }
    await transition('Draft report', 'in_progress')

    const projection = await service.getProjection('project-1', 'session-1')
    expect(projection?.lifecycle).toBe('in_progress')
    expect(projection?.document.phases[0].delegations).toHaveLength(3)
    expect(projection?.document).not.toHaveProperty('execution_strategy')
  })

  it('returns stable structured errors for approval, title, and revision violations', async () => {
    const { service, identity, generated } = await generateExecutionPlan()
    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: generated.projection.revision,
        title: 'Validate cohorts',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'plan-not-approved' })

    const approved = await service.respond({
      ...identity,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: approved.projection.revision,
        title: 'Unknown work',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'unknown-step' })
    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: generated.projection.revision,
        title: 'Validate cohorts',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
  })

  it('restores the original approval surface when replacement Artifact verification fails', async () => {
    const { service, dependencies, context } = setup()
    const original = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Please revise the Plan.'
    })
    vi.mocked(dependencies.writeArtifactForExecution).mockResolvedValueOnce({
      artifactId: 'artifact-2',
      versionId: 'version-2',
      checksum: 'b'.repeat(64),
      name: 'plan-replacement.json'
    })
    vi.mocked(dependencies.readArtifactVersion).mockResolvedValueOnce({
      content: '{"corrupt":true}',
      checksum: 'b'.repeat(64)
    })

    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        executionId: 'execution-1',
        interactionId: 'interaction-1',
        content: { ...content, task_summary: 'Replacement' }
      })
    ).rejects.toMatchObject({ code: 'artifact-unavailable' })
    expect(context().plan).toMatchObject({
      artifactVersionId: original.projection.artifactVersionId,
      approval: 'pending',
      stepStatuses: {}
    })
  })

  it('passively restores approved progress as active without reviving an interaction', async () => {
    const { service, dependencies, context, setContext } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved',
      interactionIsLive: true
    })
    const handedOffPlan = { ...context().plan! }
    Reflect.deleteProperty(handedOffPlan, 'delivery')
    setContext({ ...context(), revision: context().revision + 1, plan: handedOffPlan })
    await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: context().revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })

    const restarted = new PlanService({
      ...dependencies,
      interactions: new SessionPlanInteractionOwner()
    })
    await expect(restarted.getProjection('project-1', 'session-1')).resolves.toMatchObject({
      lifecycle: 'in_progress',
      stepStatuses: { 'Analyze the data': { status: 'in_progress' } }
    })
  })

  it('atomically queues one delivery receipt when an approved Plan is decided', async () => {
    const { service, status, context, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })

    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved',
      interactionIsLive: false
    })

    expect(status()).toBe('idle')
    expect(context().plan).toMatchObject({
      approval: 'approved',
      delivery: {
        commandId: 'delivery-1',
        kind: 'approved-plan',
        state: 'queued',
        originatingPromptMessageId: 'interaction-1',
        createdAt: 42
      }
    })
    expect(dependencies.patchRuntimeContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          approval: 'approved',
          delivery: expect.objectContaining({ state: 'queued' })
        })
      })
    )
    expect(approved.projection).toMatchObject({
      approval: 'approved',
      lifecycle: 'approved'
    })
    expect(approved.projection).not.toHaveProperty('delivery')
  })

  it('returns the existing detached approval command without minting another identity', async () => {
    const { service, context, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved',
      interactionIsLive: false
    })

    const duplicate = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: approved.projection.revision,
      decision: 'approved',
      interactionIsLive: false
    })

    expect(duplicate.changed).toBe(false)
    expect(duplicate.deliveryCommandId).toBe('delivery-1')
    await expect(
      service.queueSettledDecisionDelivery({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: approved.projection.revision,
        decision: 'approved'
      })
    ).resolves.toMatchObject({ changed: false, deliveryCommandId: 'delivery-1' })
    expect(context().plan?.delivery?.commandId).toBe('delivery-1')
    expect(dependencies.createCommandId).toHaveBeenCalledOnce()
  })

  it('keeps decision and review-feedback delivery preconditions distinct', async () => {
    const { service, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })

    await expect(
      service.queueSettledDecisionDelivery({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: context().revision,
        decision: 'approved'
      })
    ).rejects.toMatchObject({ code: 'approval-already-decided' })

    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    })
    await expect(
      service.queueReviewFeedbackDelivery({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: context().revision,
        feedbackMessageId: 'different-message'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
  })

  it('retries a decision delivery after a concurrent CAS without losing its preconditions', async () => {
    const { service, context, dependencies, setContext } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    const planWithoutReceipt = { ...context().plan! }
    Reflect.deleteProperty(planWithoutReceipt, 'delivery')
    setContext({ ...context(), plan: planWithoutReceipt })
    vi.mocked(dependencies.createCommandId!).mockReturnValue('retried-decision-delivery')
    vi.mocked(dependencies.patchRuntimeContext).mockRejectedValueOnce(
      new Error('revision conflict')
    )

    const result = await service.queueSettledDecisionDelivery({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: context().revision,
      decision: 'approved'
    })

    expect(result).toMatchObject({ changed: true, deliveryCommandId: 'retried-decision-delivery' })
    expect(context().plan?.delivery).toMatchObject({
      kind: 'approved-plan',
      originatingPromptMessageId: 'interaction-1'
    })
  })

  it('retries review-feedback delivery after a concurrent CAS without weakening Message identity', async () => {
    const { service, context, dependencies, setContext } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    })
    const planWithoutReceipt = { ...context().plan! }
    Reflect.deleteProperty(planWithoutReceipt, 'delivery')
    setContext({ ...context(), plan: planWithoutReceipt })
    vi.mocked(dependencies.createCommandId!).mockReturnValue('retried-feedback-delivery')
    vi.mocked(dependencies.patchRuntimeContext).mockRejectedValueOnce(
      new Error('revision conflict')
    )

    const result = await service.queueReviewFeedbackDelivery({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: context().revision,
      feedbackMessageId: 'message-1'
    })

    expect(result).toMatchObject({ changed: true, deliveryCommandId: 'retried-feedback-delivery' })
    expect(context().plan?.delivery).toMatchObject({
      kind: 'review-feedback',
      originatingPromptMessageId: 'message-1'
    })
  })

  it('commits a queued delivery receipt with a live Plan approval', async () => {
    const { service, status, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })

    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved',
      interactionIsLive: true
    })

    expect(status()).toBe('running')
    expect(context().plan).toMatchObject({ approval: 'approved' })
    expect(context().plan?.delivery).toMatchObject({
      kind: 'approved-plan',
      state: 'queued'
    })
  })

  it('records a detached Plan rejection with a durable delivery receipt', async () => {
    const { service, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })

    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'rejected',
      interactionIsLive: false
    })

    expect(context().plan).toMatchObject({ approval: 'rejected' })
    expect(context().plan?.delivery).toMatchObject({
      kind: 'rejected-plan',
      state: 'queued'
    })
  })

  it('fails closed when a legacy detached Plan has no durable originating Message', async () => {
    const { service, context, setContext } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    setContext({
      ...context(),
      plan: { ...context().plan!, originatingPromptMessageId: undefined }
    })

    await expect(
      service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: generated.projection.revision,
        decision: 'approved',
        interactionIsLive: false
      })
    ).rejects.toMatchObject({ code: 'invalid-plan' })
    expect(context().plan).toMatchObject({ approval: 'pending' })
    expect(context().plan).not.toHaveProperty('delivery')
  })

  it('returns private delivery context only for the exact durable receipt', async () => {
    const { service, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved',
      interactionIsLive: false
    })

    const commandId = context().plan!.delivery!.commandId
    await expect(
      service.getDeliveryContext({ projectId: 'project-1', sessionId: 'session-1', commandId })
    ).resolves.toMatchObject({
      delivery: {
        commandId,
        kind: 'approved-plan',
        originatingPromptMessageId: 'interaction-1'
      },
      projection: {
        artifactVersionId: generated.projection.artifactVersionId,
        revision: approved.projection.revision,
        approval: 'approved'
      }
    })
    await expect(
      service.getDeliveryContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        commandId: 'stale-delivery'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(approved.projection).not.toHaveProperty('delivery')
  })

  it('returns review feedback branch identity only through private delivery context', async () => {
    const { service } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const feedback = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    })

    await expect(
      service.getDeliveryContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        commandId: feedback.deliveryCommandId
      })
    ).resolves.toMatchObject({
      delivery: {
        kind: 'review-feedback',
        originatingPromptMessageId: 'message-1'
      },
      reviewFeedbackMessageId: 'message-1',
      projection: { approval: 'pending' }
    })
  })

  it('clears the hidden delivery receipt when the approved Plan reaches a terminal outcome', async () => {
    const { service, context, dependencies, setContext } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved',
      interactionIsLive: false
    })
    setContext({
      ...context(),
      plan: {
        ...context().plan!,
        delivery: { ...context().plan!.delivery!, state: 'delivering' }
      }
    })
    const started = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: approved.projection.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })

    const completed = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: started.projection.revision,
      title: 'Analyze the data',
      status: 'completed'
    })

    expect(completed.projection.lifecycle).toBe('completed')
    expect(context().plan?.delivery).toBeUndefined()
    expect(vi.mocked(dependencies.patchRuntimeContext).mock.lastCall?.[0].plan).not.toHaveProperty(
      'delivery'
    )
  })

  it('drops an unreadable embedded Plan document instead of exposing corrupt state', async () => {
    const { service, context, setContext, status } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    setContext({
      ...context(),
      plan: {
        ...context().plan!,
        document: { schema_version: 1 } as never
      }
    })

    await expect(service.getProjection('project-1', 'session-1')).resolves.toBeNull()
    expect(context().plan).toBeUndefined()
    expect(status()).toBe('idle')
  })

  it('drops a checksum-valid restored Plan when the embedded document structure is corrupt', async () => {
    const { service, context, setContext, status } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    const corrupt = {
      schema_version: 1,
      task_summary: 'Missing phases',
      phases: [],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Invalid structure.' }
    }
    const serialized = JSON.stringify(corrupt, null, 2)
    setContext({
      ...context(),
      plan: {
        ...context().plan!,
        artifactChecksum: createHash('sha256').update(serialized).digest('hex'),
        document: corrupt as never
      }
    })

    await expect(service.getProjection('project-1', 'session-1')).resolves.toBeNull()
    expect(context().plan).toBeUndefined()
    expect(status()).toBe('idle')
  })

  it('retains a verified restored Plan when unpublished provenance content is unavailable', async () => {
    const { service, dependencies, context, status } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      interactionId: 'interaction-1',
      content
    })
    vi.mocked(dependencies.readArtifactVersion).mockRejectedValueOnce(
      new Error('pending content is missing')
    )

    await expect(service.getProjection('project-1', 'session-1')).resolves.toMatchObject({
      approval: 'pending',
      lifecycle: 'awaiting_approval',
      document: { task_summary: content.task_summary }
    })
    expect(context().plan).toBeDefined()
    expect(status()).toBe('waiting-plan-approval')
  })

  it('drives deterministic fake-Agent blocked and completed acceptance flows', async () => {
    const run = async (terminal: 'blocked' | 'completed'): Promise<ActivePlanProjection> => {
      const { service } = setup()
      const fakeAgent = {
        generate: () =>
          service.generate({
            projectId: 'project-1',
            sessionId: 'session-1',
            executionId: 'execution-1',
            interactionId: `interaction-${terminal}`,
            content
          }),
        approve: (projection: ActivePlanProjection) =>
          service.respond({
            projectId: 'project-1',
            sessionId: 'session-1',
            artifactVersionId: projection.artifactVersionId,
            expectedRevision: projection.revision,
            decision: 'approved',
            interactionIsLive: true
          }),
        update: (
          projection: ActivePlanProjection,
          status: 'in_progress' | 'blocked' | 'completed'
        ) =>
          service.updateStepStatus({
            projectId: 'project-1',
            sessionId: 'session-1',
            artifactVersionId: projection.artifactVersionId,
            expectedRevision: projection.revision,
            title: 'Analyze the data',
            status,
            ...(status === 'blocked' ? { notes: 'Deterministic fixture input is missing.' } : {})
          })
      }

      const generated = await fakeAgent.generate()
      expect(generated.projection).toMatchObject({
        lifecycle: 'awaiting_approval',
        approval: 'pending'
      })
      const approved = await fakeAgent.approve(generated.projection)
      const executing = await fakeAgent.update(approved.projection, 'in_progress')
      return (await fakeAgent.update(executing.projection, terminal)).projection
    }

    await expect(run('blocked')).resolves.toMatchObject({
      lifecycle: 'blocked',
      stepStates: {
        'Analyze the data': {
          status: 'blocked',
          notes: 'Deterministic fixture input is missing.'
        }
      }
    })
    await expect(run('completed')).resolves.toMatchObject({
      lifecycle: 'completed',
      counts: { completed: 1, steps: 1 }
    })
  })
})
