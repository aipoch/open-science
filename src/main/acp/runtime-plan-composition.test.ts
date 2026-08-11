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
import type { ActivePlanProjection, PlanResponseCommand } from '../../shared/session-plan/contract'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import { composeAcpRuntimePlanWorkflow } from './runtime-plan-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

const projectRoot = resolve(__dirname, '../../..')

const pendingProjection = (): ActivePlanProjection => ({
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  originatingPromptMessageId: 'prompt-1',
  revision: 1,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
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

const createHarness = (): {
  workflow: ReturnType<typeof composeAcpRuntimePlanWorkflow>
  interactions: SessionPlanInteractionOwner
  sessionInteractions: AcpSessionInteractionOwner
  interaction: ReturnType<AcpSessionInteractionOwner['claim']>
  respond: ReturnType<typeof vi.fn>
} => {
  const interactions = new SessionPlanInteractionOwner()
  const sessionInteractions = new AcpSessionInteractionOwner()
  const interaction = sessionInteractions.claim({
    sessionId: 'session-1',
    kind: 'prompt',
    promptMessageId: 'prompt-1'
  })
  let current = pendingProjection()
  const generate = vi.fn(async () => {
    interactions.register({
      sessionId: 'session-1',
      artifactVersionId: current.artifactVersionId,
      interactionId: 'prompt-1'
    })
    return { projection: current, pauseInteraction: true as const }
  })
  const respond = vi.fn(async (rawInput: unknown) => {
    const input = rawInput as { feedback?: string; decision?: 'approved' | 'rejected' }
    if (input.feedback !== undefined) {
      interactions.release('session-1', current.artifactVersionId)
      return {
        kind: 'feedback' as const,
        routeToInteractionId: 'prompt-1',
        artifactVersionId: current.artifactVersionId,
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
    current =
      input.decision === 'approved'
        ? approvedProjection(current.revision + 1)
        : { ...current, approval: 'rejected' as const, lifecycle: 'rejected' as const }
    return { projection: current, changed: true }
  })
  const updateStepStatus = vi.fn(async () => {
    current = approvedProjection(current.revision + 1)
    return { projection: current, changed: true }
  })
  const service = {
    generate,
    respond,
    updateStepStatus,
    getProjection: vi.fn(async () => current)
  }
  const publication = { pushEvent: vi.fn() }
  const workflow = composeAcpRuntimePlanWorkflow(
    {
      plan: {
        sessions: { containsMessageOnActiveBranch: vi.fn(async () => true) }
      }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[0],
    {
      planService: service,
      planInteractions: interactions,
      sessionInteractions,
      artifactTurns: { promptMessageIdFor: vi.fn(() => 'prompt-1') }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
    {
      publication,
      sessionEnvironment: { projectName: vi.fn(() => 'project-1') }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2]
  )

  return { workflow, interactions, sessionInteractions, interaction, respond }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ACP Session Plan approval causality', () => {
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
    harness.sessionInteractions.release(harness.interaction)
  })
})

describe('ACP Runtime Session Plan composition', () => {
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

  it('authorizes one Agent decision from restored pending Plan feedback without execution authority', async () => {
    const harness = createHarness()
    const request: AcpPromptRequest = {
      sessionId: 'session-1',
      text: 'The restored Plan looks good.',
      planContinuation: {
        projectId: 'project-1',
        artifactVersionId: 'version-1',
        expectedRevision: 1,
        pendingAction: 'review'
      }
    }

    const protectedPlan = await harness.workflow.prompt.preflight(request)
    if (harness.interaction.kind !== 'prompt') throw new Error('Expected a prompt interaction.')
    const interaction = harness.interaction
    const admitted = await harness.workflow.prompt.admit(request, interaction, protectedPlan)

    expect(admitted.protectedPending).toMatchObject({ approval: 'pending' })
    expect(
      harness.interactions.isAgentDecisionAuthorized({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: interaction.sequence
      })
    ).toBe(true)
    expect(harness.interactions.executionBindingFor('session-1')).toBeUndefined()

    harness.workflow.prompt.beforeRelease('session-1', interaction)
    harness.sessionInteractions.release(interaction)
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
