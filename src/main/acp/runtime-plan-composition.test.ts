import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createPlanMcpServer,
  createPlanMcpServerForEnvironment
} from '../session-plan/plan-mcp-server'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import {
  derivePlanLifecycle,
  formatPlanProtectedContext,
  projectPlanStepStates,
  type ActivePlanProjection,
  type PlanResponseCommand
} from '../../shared/session-plan/contract'
import { getNotebookInputRoot } from '../notebook/input-staging'
import type { PlanContextFileStore } from '../session-plan/plan-context-file'
import { PlanService } from '../session-plan/plan-service'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import {
  AcpSessionInteractionOwner,
  type AcpPromptSessionInteractionScope
} from './session-interaction-owner'
import { composeAcpRuntimePlanWorkflow } from './runtime-plan-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpPromptTurnMode } from './prompt-turn-workflow'

const projectRoot = resolve(__dirname, '../../..')
const temporaryRoots: string[] = []

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-plan-context-'))
  temporaryRoots.push(root)
  return root
}

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
    pauseProvider?: (sessionId: string, sequence: number) => () => void
    initialProjection?: ActivePlanProjection
    containsOriginatingMessage?: boolean
    deliveryContext?: Readonly<{
      delivery: SessionPlanDelivery
      projection: ActivePlanProjection
      reviewFeedbackMessageId?: string
    }>
    contextFileStorageRoot?: string
    contextFiles?: Pick<PlanContextFileStore, 'refresh'>
    beforeUpdateAuthorization?: () => Promise<void>
    durablePromptMessageId?: string | null
  }> = {}
): {
  workflow: ReturnType<typeof composeAcpRuntimePlanWorkflow>
  interactions: SessionPlanInteractionOwner
  sessionInteractions: AcpSessionInteractionOwner
  interaction: AcpPromptSessionInteractionScope
  respond: ReturnType<typeof vi.fn>
  generate: ReturnType<typeof vi.fn>
  queueSettledDecisionDelivery: ReturnType<typeof vi.fn>
  queueReviewFeedbackDelivery: ReturnType<typeof vi.fn>
  getProjection: ReturnType<typeof vi.fn>
  getDeliveryContext: ReturnType<typeof vi.fn>
  discardUnavailable: ReturnType<typeof vi.fn>
  containsMessageOnActiveBranch: ReturnType<typeof vi.fn>
  setProjection: (projection: ActivePlanProjection | null) => void
  deliveryState: () => 'queued' | 'delivering' | 'accepted' | undefined
  deliveries: Readonly<{
    accept: ReturnType<typeof vi.fn>
    begin: ReturnType<typeof vi.fn<() => Promise<boolean>>>
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
  let projectionAvailable = true
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
    current = {
      ...current,
      revision: current.revision + 1,
      approval: input.decision === 'approved' ? ('approved' as const) : ('rejected' as const),
      lifecycle: input.decision === 'approved' ? ('approved' as const) : ('rejected' as const)
    }
    deliveryState = 'queued'
    return { projection: current, changed: true, deliveryCommandId: 'receipt-1' }
  })
  const updateStepStatus = vi.fn(
    async (input: {
      title?: string
      status?: 'in_progress' | 'completed' | 'blocked' | 'skipped'
      notes?: string
      authorizeUpdate?: (projection: ActivePlanProjection) => void | Promise<void>
    }) => {
      await options.beforeUpdateAuthorization?.()
      await input.authorizeUpdate?.(current)
      const title = input.title ?? 'private-step-title-marker'
      const status = input.status ?? 'in_progress'
      const stepStatuses = {
        ...current.stepStatuses,
        [title]: { status, updatedAt: 42, ...(input.notes ? { notes: input.notes } : {}) }
      }
      current = {
        ...current,
        revision: current.revision + 1,
        lifecycle: derivePlanLifecycle(current.document, current.approval, stepStatuses),
        stepStatuses,
        stepStates: projectPlanStepStates(current.document, stepStatuses)
      }
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
  const getProjection = vi.fn(async () => (projectionAvailable ? current : null))
  const getDeliveryContext = vi.fn(async () => {
    if (!options.deliveryContext) throw new Error('No delivery context configured.')
    return options.deliveryContext
  })
  const discardUnavailable = vi.fn(
    async (input: {
      authorizeDiscard?: (plan: { originatingPromptMessageId: string }) => Promise<void>
      beforePersist?: () => void
    }) => {
      await input.authorizeDiscard?.({ originatingPromptMessageId: 'prompt-1' })
      input.beforePersist?.()
      projectionAvailable = false
      return { revision: current.revision + 1 }
    }
  )
  const service = {
    generate,
    respond,
    updateStepStatus,
    queueSettledDecisionDelivery,
    queueReviewFeedbackDelivery,
    getProjection,
    getDeliveryContext,
    discardUnavailable
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
      },
      ...(options.contextFileStorageRoot
        ? {
            artifacts: { dataRoot: options.contextFileStorageRoot },
            notebook: {}
          }
        : {})
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[0],
    {
      planService: service,
      backendGeneration: { current: { framework: { id: 'codex' } } },
      planInteractions: interactions,
      sessionInteractions,
      artifactTurns: {
        handleForExecution: vi.fn(() => 'artifact-turn'),
        snapshot: vi.fn(() =>
          options.durablePromptMessageId === null
            ? {}
            : { promptMessageId: options.durablePromptMessageId ?? 'prompt-1' }
        )
      }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
    {
      publication,
      sessionEnvironment: { projectId: vi.fn(() => 'project-1') }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2],
    {
      deliveries,
      pauseProvider: options.pauseProvider,
      ...(options.contextFiles ? { contextFiles: options.contextFiles } : {})
    }
  )

  return {
    workflow,
    interactions,
    sessionInteractions,
    interaction,
    respond,
    generate,
    queueSettledDecisionDelivery,
    queueReviewFeedbackDelivery,
    getProjection,
    getDeliveryContext,
    discardUnavailable,
    containsMessageOnActiveBranch,
    setProjection: (projection) => {
      projectionAvailable = projection !== null
      if (projection) current = projection
    },
    deliveryState: () => deliveryState,
    deliveries
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('ACP Session Plan approval causality', () => {
  it('preserves a replacement waiter when stale feedback cleanup reuses the prompt ID', async () => {
    const harness = createHarness()
    harness.interactions.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionId: 'prompt-1'
    })
    const oldApproval = harness.interactions
      .parkApproval('session-1', 'prompt-1')
      .catch(() => undefined)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const originalRespond = harness.respond.getMockImplementation() as (
      input: unknown
    ) => Promise<unknown>
    harness.respond.mockImplementationOnce(async (input) => {
      entered.resolve()
      await resume.promise
      return originalRespond(input)
    })
    const response = harness.workflow
      .respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        feedback: 'Revise the analysis.'
      })
      .catch((error: unknown) => error)
    await entered.promise
    harness.interactions.rejectApproval('session-1', 'old prompt detached')
    await oldApproval
    harness.sessionInteractions.release(harness.interaction)
    harness.sessionInteractions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'prompt-1'
    })
    harness.interactions.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-2',
      interactionId: 'prompt-1'
    })
    const rejected = vi.fn()
    const replacement = harness.interactions.parkApproval('session-1', 'prompt-1').catch(rejected)
    const token = harness.interactions.approvalTokenFor('session-1')
    try {
      resume.resolve()
      expect(await response).toMatchObject({ code: 'interaction-mismatch' })
      expect.soft(rejected).not.toHaveBeenCalled()
      expect.soft(harness.interactions.approvalTokenFor('session-1')).toBe(token)
      expect(harness.interactions.interactionIdFor('session-1', 'version-2')).toBe('prompt-1')
    } finally {
      harness.interactions.clearSession('session-1', 'test cleanup')
      await replacement
    }
  })

  it.each(
    ['approved', 'rejected', 'feedback'].flatMap((responseKind) =>
      [false, true].map((reusePrompt) => ({
        responseKind: responseKind as 'approved' | 'rejected' | 'feedback',
        reusePrompt
      }))
    )
  )(
    'P02 preserves the replacement waiter for $responseKind (reuse prompt: $reusePrompt)',
    async ({ responseKind, reusePrompt }) => {
      const harness = createHarness()
      const replacementPrompt = reusePrompt ? 'prompt-1' : 'prompt-2'
      const controller = new AbortController()
      const generation = harness.workflow
        .call({
          projectId: 'project-1',
          sessionId: 'session-1',
          operation: 'generate',
          input: {},
          signal: controller.signal
        })
        .catch((error: unknown) => error)
      await vi.waitFor(() =>
        expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
      )
      let releaseBegin!: () => void
      const barrier = new Promise<void>((resolve) => {
        releaseBegin = resolve
      })
      const originalBegin =
        harness.deliveries.begin.getMockImplementation() as () => Promise<boolean>
      harness.deliveries.begin.mockImplementationOnce(async () => {
        await barrier
        return originalBegin()
      })
      const response = harness.workflow.respond(
        responseKind === 'feedback'
          ? { projectId: 'project-1', sessionId: 'session-1', feedback: 'Revise the analysis.' }
          : {
              projectId: 'project-1',
              sessionId: 'session-1',
              artifactVersionId: 'version-1',
              expectedRevision: 1,
              decision: responseKind
            }
      )
      await vi.waitFor(() => expect(harness.deliveries.begin).toHaveBeenCalledOnce())
      controller.abort()
      await expect(generation).resolves.toBeInstanceOf(Error)
      harness.sessionInteractions.release(harness.interaction)
      harness.sessionInteractions.claim({
        sessionId: 'session-1',
        kind: 'prompt',
        promptMessageId: replacementPrompt
      })
      harness.interactions.register({
        sessionId: 'session-1',
        artifactVersionId: 'version-2',
        interactionId: replacementPrompt
      })
      const received = vi.fn()
      const replacement = harness.interactions
        .parkApproval('session-1', replacementPrompt)
        .then(received, () => undefined)
      try {
        releaseBegin()
        await response
        expect.soft(received).not.toHaveBeenCalled()
        expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe(replacementPrompt)
        expect(harness.deliveries.clear).not.toHaveBeenCalled()
        expect(harness.deliveries.rearmUnaccepted).toHaveBeenCalledWith(
          'project-1',
          'session-1',
          'receipt-1'
        )
      } finally {
        harness.interactions.clearSession('session-1', 'test cleanup')
        await replacement
      }
    }
  )

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

  it('keeps a healthy generate call blocked and returns approval without stopping the Provider', async () => {
    const pauseProvider = vi.fn(() => vi.fn())
    const harness = createHarness({ pauseProvider })
    const generation = harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {},
      signal: new AbortController().signal
    })
    let finished = false
    void generation.then(() => {
      finished = true
    })
    await vi.waitFor(() =>
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    )
    expect(finished).toBe(false)
    expect(pauseProvider).not.toHaveBeenCalled()
    await harness.workflow.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      decision: 'approved'
    })
    await expect(generation).resolves.toMatchObject({ projection: { approval: 'approved' } })
    expect(pauseProvider).not.toHaveBeenCalled()
    expect(harness.sessionInteractions.current('session-1')).toBe(harness.interaction)
  })

  it('pauses on a failed Plan tool notification even without MCP cancellation and deduplicates later disconnect', async () => {
    const pauseProvider = vi.fn(() => vi.fn())
    const harness = createHarness({ pauseProvider })
    const controller = new AbortController()
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
    harness.workflow.prompt.toolWaitFailed?.(harness.interaction)
    expect(pauseProvider).toHaveBeenCalledOnce()
    controller.abort()
    await expect(generation).rejects.toThrow('transport disconnected')
    expect(pauseProvider).toHaveBeenCalledOnce()
    expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    harness.interactions.clearAll('Test closed')
  })

  it('survives an actual MCP client request timeout without releasing application approval', async () => {
    const harness = createHarness({ pauseProvider: () => vi.fn() })
    const server = createPlanMcpServer({
      generate: (input, signal) =>
        harness.workflow.call({
          projectId: 'project-1',
          sessionId: 'session-1',
          operation: 'generate',
          input,
          signal
        }),
      approve: vi.fn(),
      reject: vi.fn(),
      updateStepStatus: vi.fn()
    })
    const client = new Client({ name: 'plan-timeout-regression', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    try {
      const content = { ...pendingProjection().document }
      Reflect.deleteProperty(content, 'schema_version')
      await expect(
        client.callTool({ name: 'generate_plan', arguments: content }, undefined, { timeout: 30 })
      ).rejects.toThrow(/timed out/i)
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
      expect(harness.workflow.prompt.isProviderPaused?.(harness.interaction)).toBe(true)
      await expect(
        harness.workflow.call({
          projectId: 'project-1',
          sessionId: 'session-1',
          operation: 'approve'
        })
      ).rejects.toMatchObject({ code: 'plan-review-pending' })
      expect(harness.deliveries.begin).not.toHaveBeenCalled()
    } finally {
      harness.interactions.clearAll('Test closed')
      await client.close()
      await server.close()
    }
  })

  it.each(['available', 'unavailable', 'mismatch'] as const)(
    'keeps the %s Plan file state in the resumed Provider context after an actual MCP timeout',
    async (fileState) => {
      const refresh = vi.fn(async () => {
        if (fileState === 'unavailable') throw new Error('disk unavailable')
        return {
          path: '/private/input/session-plan/current.json',
          artifactVersionId: 'version-1',
          revision: fileState === 'mismatch' ? 99 : 2
        }
      })
      const harness = createHarness({
        pauseProvider: () => vi.fn(),
        contextFiles: { refresh }
      })
      const server = createPlanMcpServer({
        generate: (input, signal) =>
          harness.workflow.call({
            projectId: 'project-1',
            sessionId: 'session-1',
            operation: 'generate',
            input,
            signal
          }),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn()
      })
      const client = new Client({ name: `plan-resume-${fileState}`, version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
      try {
        const content = { ...pendingProjection().document }
        Reflect.deleteProperty(content, 'schema_version')
        await expect(
          client.callTool({ name: 'generate_plan', arguments: content }, undefined, { timeout: 30 })
        ).rejects.toThrow(/timed out/i)
        await harness.workflow.respond({
          projectId: 'project-1',
          sessionId: 'session-1',
          artifactVersionId: 'version-1',
          expectedRevision: 1,
          decision: 'approved'
        })
        harness.getDeliveryContext.mockResolvedValue({
          projection: await harness.workflow.projection('project-1', 'session-1'),
          delivery: { commandId: 'receipt-1' }
        })

        const resumed = await harness.workflow.prompt.resumeAfterProviderStop!(harness.interaction)

        if (fileState === 'unavailable') {
          expect(resumed?.content).toContain('task=private-task-summary-marker')
          expect(resumed?.content).toContain('- private-step-title-marker: not_started')
          expect(resumed?.content).toContain(
            'an authoritative summary of the Plan as read for this request'
          )
          expect(resumed?.content).toContain('do not guarantee that the Plan remained unchanged')
        } else {
          expect(resumed?.content).not.toContain('private-task-summary-marker')
          expect(resumed?.content).not.toContain('private-step-title-marker')
        }
        expect(resumed?.content).toContain('expectedArtifactVersionId=version-1 expectedRevision=2')
        expect(resumed?.content).toContain(
          fileState === 'available'
            ? 'session-plan/current.json'
            : fileState === 'unavailable'
              ? 'Plan file is unavailable'
              : 'changed during request preparation'
        )
        expect(refresh).toHaveBeenCalledTimes(3)
      } finally {
        harness.interactions.clearAll('Test closed')
        await client.close()
        await server.close()
      }
    }
  )

  it.each(['approved', 'rejected', 'feedback'] as const)(
    'keeps the application paused after MCP timeout and delivers %s only after Provider stop',
    async (decision) => {
      const dispose = vi.fn()
      const pauseProvider = vi.fn(() => dispose)
      const harness = createHarness({ pauseProvider })
      const controller = new AbortController()
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
      expect(pauseProvider).not.toHaveBeenCalled()
      controller.abort()
      expect(pauseProvider).toHaveBeenCalledOnce()
      await expect(generation).rejects.toThrow('transport disconnected')
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
      expect(harness.workflow.prompt.isProviderPaused?.(harness.interaction)).toBe(true)
      const result = await harness.workflow.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        ...(decision === 'feedback'
          ? { feedback: 'Revise the analysis.' }
          : { artifactVersionId: 'version-1', expectedRevision: 1, decision })
      })
      expect(result).not.toHaveProperty('deliveryCommandId') // no competing app continuation
      expect(harness.deliveries.begin).not.toHaveBeenCalled()
      expect(harness.deliveryState()).toBe('queued')
      harness.getDeliveryContext.mockResolvedValue({
        projection: await harness.workflow.projection('project-1', 'session-1'),
        delivery: { commandId: 'receipt-1' }
      })
      const resumed = await harness.workflow.prompt.resumeAfterProviderStop?.(harness.interaction)
      expect(dispose).toHaveBeenCalled()
      expect(resumed).toBeDefined()
      expect(harness.deliveryState()).toBe('queued')
      await resumed?.dispatch?.()
      expect(harness.deliveryState()).toBe('delivering')
      expect(harness.deliveries.clear).not.toHaveBeenCalled()
      if (decision === 'feedback') {
        expect(resumed?.content).toContain('Revise the analysis.')
        expect(resumed?.content).not.toContain('Use this approved Session Plan')
        expect(resumed?.content).toContain('pending review, not approved execution context')
        expect((await harness.workflow.projection('project-1', 'session-1'))?.approval).toBe(
          'pending'
        )
      }
      await resumed?.accepted()
      expect(harness.deliveryState()).toBeUndefined()
      expect(harness.deliveries.accept).toHaveBeenCalledOnce()
    }
  )

  it.each(['approved', 'feedback'] as const)(
    'preserves %s delivery when timeout races the live handoff claim',
    async (decision) => {
      const controller = new AbortController()
      const harness = createHarness({ pauseProvider: () => vi.fn() })
      const generation = harness.workflow
        .call({
          projectId: 'project-1',
          sessionId: 'session-1',
          operation: 'generate',
          input: {},
          signal: controller.signal
        })
        .catch((error: unknown) => error)
      await vi.waitFor(() =>
        expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
      )
      const begin = harness.deliveries.begin.getMockImplementation()!
      harness.deliveries.begin.mockImplementationOnce(async () => {
        const claimed = await begin()
        controller.abort()
        return claimed
      })
      await harness.workflow.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        ...(decision === 'feedback'
          ? { feedback: 'Revise the plan.' }
          : { decision, artifactVersionId: 'version-1', expectedRevision: 1 })
      })
      expect(await generation).toBeInstanceOf(Error)
      expect(harness.deliveryState()).toBe('queued')
      expect(harness.deliveries.clear).not.toHaveBeenCalled()
      harness.getDeliveryContext.mockResolvedValue({
        projection: await harness.workflow.projection('project-1', 'session-1'),
        delivery: { commandId: 'receipt-1' }
      })
      const resumed = await harness.workflow.prompt.resumeAfterProviderStop!(harness.interaction)
      expect(resumed).toBeDefined()
      await resumed?.dispatch?.()
      await resumed?.accepted()
      expect(harness.deliveryState()).toBeUndefined()
    }
  )

  it('waits without dispatching until a human responds and releases the wait on user cancellation', async () => {
    const harness = createHarness({ pauseProvider: () => vi.fn() })
    const controller = new AbortController()
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
    await expect(generation).rejects.toThrow('transport disconnected')
    let resumed = false
    const continuation = harness.workflow.prompt.resumeAfterProviderStop!(harness.interaction)
    void continuation.then(
      () => {
        resumed = true
      },
      () => undefined
    )
    await Promise.resolve()
    expect(resumed).toBe(false)
    expect(harness.deliveries.begin).not.toHaveBeenCalled()
    harness.workflow.capturePromptCancellation('session-1')()
    await expect(continuation).rejects.toThrow('cancelled')
  })

  it('projects a stable review identity until the Agent requests another review of the same version', async () => {
    const harness = createHarness()
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate' as const,
      input: {}
    }
    const first = harness.workflow.call(request)
    await vi.waitFor(() =>
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    )
    const initial = await harness.workflow.projection('project-1', 'session-1')
    expect(initial?.reviewRequestId).toBeTypeOf('string')
    await harness.workflow.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Please explain the scope.'
    })
    await first
    const refreshed = await harness.workflow.projection('project-1', 'session-1')
    expect(refreshed?.revision).toBeGreaterThan(initial!.revision)
    expect(refreshed?.reviewRequestId).toBe(initial?.reviewRequestId)
    const second = harness.workflow.call(request)
    await vi.waitFor(() =>
      expect(harness.interactions.approvalInteractionIdFor('session-1')).toBe('prompt-1')
    )
    const rereview = await harness.workflow.projection('project-1', 'session-1')
    expect(rereview?.artifactVersionId).toBe(initial?.artifactVersionId)
    expect(rereview?.reviewRequestId).not.toBe(initial?.reviewRequestId)
    harness.interactions.resolveApproval(
      'session-1',
      {},
      harness.interactions.approvalTokenFor('session-1')
    )
    await second
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
  it('keeps the complete approved Plan file current across replacement and terminal updates', async () => {
    const storageRoot = await createTemporaryRoot()
    const harness = createHarness({
      initialProjection: approvedProjection(4),
      contextFileStorageRoot: storageRoot
    })
    const request: AcpPromptRequest = { sessionId: 'session-1', text: 'Continue the work.' }
    const contextPath = join(
      getNotebookInputRoot(storageRoot, 'project-1', 'session-1'),
      'session-plan',
      'current.json'
    )

    const preflight = await harness.workflow.prompt.preflight(request, { kind: 'user' })
    expect(preflight).toMatchObject({
      active: { artifactVersionId: 'version-1', revision: 4 },
      source: {
        kind: 'file-reference',
        reference: expect.stringContaining('OPEN_SCIENCE_INPUT_DIR')
      }
    })
    expect(preflight.source?.kind).toBe('file-reference')
    if (preflight.source?.kind !== 'file-reference') throw new Error('Expected file reference.')
    expect(preflight.source.reference).toContain('bash_execute')
    expect(preflight.source.reference).toContain('session-plan/current.json')
    expect(preflight.source.reference).not.toContain('private-step-description-marker')
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      schemaVersion: 1,
      active: true,
      artifactVersionId: 'version-1',
      revision: 4,
      document: {
        task_summary: 'private-task-summary-marker',
        phases: [
          {
            delegations: [
              {
                steps: [
                  {
                    title: 'private-step-title-marker',
                    description: 'private-step-description-marker'
                  }
                ]
              }
            ]
          }
        ]
      }
    })

    const progress = await harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'updateStepStatus',
      input: { title: 'private-step-title-marker', status: 'in_progress' }
    })
    expect(progress).toMatchObject({
      projection: {
        lifecycle: 'in_progress',
        stepStates: { 'private-step-title-marker': { status: 'in_progress' } }
      }
    })
    expect(progress).not.toHaveProperty('planContext')
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      active: true,
      lifecycle: 'in_progress',
      stepStates: { 'private-step-title-marker': { status: 'in_progress' } }
    })

    harness.setProjection({
      ...pendingProjection(),
      artifactId: 'artifact-2',
      artifactVersionId: 'version-2',
      artifactChecksum: 'b'.repeat(64),
      revision: 6
    })
    await expect(harness.workflow.prompt.preflight(request, { kind: 'user' })).resolves.toEqual({})
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      schemaVersion: 1,
      active: false,
      approval: 'pending',
      lifecycle: 'awaiting_approval',
      artifactVersionId: 'version-2',
      revision: 6,
      document: {
        task_summary: 'private-task-summary-marker',
        phases: expect.any(Array)
      }
    })

    harness.interactions.authorizeAgentDecision({
      sessionId: 'session-1',
      artifactVersionId: 'version-2',
      interactionSequence: harness.interaction.sequence
    })
    const approved = await harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'approve'
    })
    expect(approved).toMatchObject({
      projection: { approval: 'approved', artifactVersionId: 'version-2' },
      planContext: expect.stringContaining('session-plan/current.json')
    })
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      active: true,
      approval: 'approved',
      artifactVersionId: 'version-2'
    })

    await harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'updateStepStatus',
      input: { title: 'private-step-title-marker', status: 'completed' }
    })
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      active: false,
      approval: 'approved',
      lifecycle: 'completed',
      artifactVersionId: 'version-2',
      stepStates: { 'private-step-title-marker': { status: 'completed' } }
    })
    await expect(harness.workflow.prompt.preflight(request, { kind: 'user' })).resolves.toEqual({})
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      active: false,
      lifecycle: 'completed',
      artifactVersionId: 'version-2',
      document: { task_summary: 'private-task-summary-marker' }
    })
  })

  it.each([
    ['a sibling branch', approvedProjection(4), true],
    ['no current Plan', null, false]
  ] as const)('tombstones a previous Plan file for %s', async (_case, projection, sibling) => {
    const storageRoot = await createTemporaryRoot()
    const harness = createHarness({
      initialProjection: approvedProjection(3),
      contextFileStorageRoot: storageRoot
    })
    const request: AcpPromptRequest = { sessionId: 'session-1', text: 'Continue.' }
    const contextPath = join(
      getNotebookInputRoot(storageRoot, 'project-1', 'session-1'),
      'session-plan',
      'current.json'
    )
    await harness.workflow.prompt.preflight(request, { kind: 'user' })
    harness.setProjection(projection)
    if (sibling) harness.containsMessageOnActiveBranch.mockResolvedValue(false)

    await expect(harness.workflow.prompt.preflight(request, { kind: 'user' })).resolves.toEqual({})
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      active: false
    })
  })

  it.each([
    [
      'is replaced',
      {
        ...approvedProjection(5),
        artifactId: 'artifact-2',
        artifactVersionId: 'version-2',
        artifactChecksum: 'b'.repeat(64)
      },
      'version-2'
    ],
    ['becomes terminal', { ...approvedProjection(5), lifecycle: 'completed' as const }, undefined]
  ] as const)(
    'does not return the first preflight snapshot when the Plan %s during file refresh',
    async (_case, changed, expectedActiveVersion) => {
      const storageRoot = await createTemporaryRoot()
      const first = approvedProjection(4)
      const harness = createHarness({
        initialProjection: first,
        contextFileStorageRoot: storageRoot
      })
      harness.getProjection
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(changed)
        .mockResolvedValueOnce(changed)
        .mockResolvedValueOnce(changed)

      const preflight = await harness.workflow.prompt.preflight(
        { sessionId: 'session-1', text: 'Continue.' },
        { kind: 'user' }
      )

      if (expectedActiveVersion) {
        expect(preflight).toMatchObject({
          active: { artifactVersionId: expectedActiveVersion, revision: 5 },
          source: {
            kind: 'file-reference',
            reference: expect.stringContaining('session-plan/current.json')
          }
        })
        expect(preflight.source).not.toEqual(
          expect.objectContaining({
            warning: expect.stringContaining('changed during request preparation')
          })
        )
      } else {
        expect(preflight).toEqual({})
        await expect(
          readFile(
            join(
              getNotebookInputRoot(storageRoot, 'project-1', 'session-1'),
              'session-plan',
              'current.json'
            ),
            'utf8'
          ).then(JSON.parse)
        ).resolves.toMatchObject({ active: false, lifecycle: 'completed', revision: 5 })
      }
      expect(harness.getProjection).toHaveBeenCalledTimes(4)
    }
  )

  it('publishes the second terminal snapshot when the first refresh was still active', async () => {
    const storageRoot = await createTemporaryRoot()
    const first = approvedProjection(4)
    const refreshedActive = {
      ...approvedProjection(5),
      artifactVersionId: 'version-2',
      artifactChecksum: 'b'.repeat(64)
    }
    const currentTerminal = {
      ...refreshedActive,
      revision: 6,
      lifecycle: 'completed' as const
    }
    const harness = createHarness({
      initialProjection: first,
      contextFileStorageRoot: storageRoot
    })
    harness.getProjection
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(refreshedActive)
      .mockResolvedValueOnce(currentTerminal)
      .mockResolvedValueOnce(currentTerminal)

    await expect(
      harness.workflow.prompt.preflight(
        { sessionId: 'session-1', text: 'Continue.' },
        { kind: 'user' }
      )
    ).resolves.toEqual({})

    expect(harness.getProjection).toHaveBeenCalledTimes(4)
    await expect(
      readFile(
        join(
          getNotebookInputRoot(storageRoot, 'project-1', 'session-1'),
          'session-plan',
          'current.json'
        ),
        'utf8'
      ).then(JSON.parse)
    ).resolves.toMatchObject({
      active: false,
      artifactVersionId: 'version-2',
      lifecycle: 'completed',
      revision: 6
    })
  })

  it('bounds repeated preflight changes and exposes the expected identity with mismatch guidance', async () => {
    const storageRoot = await createTemporaryRoot()
    const version = (revision: number, suffix: string): ActivePlanProjection => ({
      ...approvedProjection(revision),
      artifactId: `artifact-${suffix}`,
      artifactVersionId: `version-${suffix}`,
      artifactChecksum: suffix.repeat(64).slice(0, 64)
    })
    const first = version(4, 'a')
    const refreshed = version(5, 'b')
    const admitted = version(6, 'c')
    const latestFile = version(7, 'd')
    const harness = createHarness({
      initialProjection: first,
      contextFileStorageRoot: storageRoot
    })
    harness.getProjection
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(admitted)
      .mockResolvedValueOnce(latestFile)

    const preflight = await harness.workflow.prompt.preflight(
      { sessionId: 'session-1', text: 'Continue.' },
      { kind: 'user' }
    )
    const projected = preflight.active!
    const delivered = formatPlanProtectedContext(projected, preflight.source)

    expect(harness.getProjection).toHaveBeenCalledTimes(4)
    expect(delivered).toContain('expectedArtifactVersionId=version-c expectedRevision=6')
    expect(delivered).toContain('changed during request preparation')
    expect(delivered).not.toContain('private-task-summary-marker')
    await expect(
      readFile(
        join(
          getNotebookInputRoot(storageRoot, 'project-1', 'session-1'),
          'session-plan',
          'current.json'
        ),
        'utf8'
      ).then(JSON.parse)
    ).resolves.toMatchObject({ artifactVersionId: 'version-d', revision: 7 })
  })

  it('falls back to the admitted Plan snapshot when its file cannot be refreshed', async () => {
    const harness = createHarness({
      initialProjection: approvedProjection(4),
      contextFiles: {
        refresh: vi.fn(async () => {
          throw new Error('disk unavailable')
        })
      }
    })

    const preflight = await harness.workflow.prompt.preflight(
      { sessionId: 'session-1', text: 'Continue.' },
      { kind: 'user' }
    )
    const delivered = formatPlanProtectedContext(preflight.active!, preflight.source)

    expect(preflight.source).toMatchObject({ kind: 'file-unavailable' })
    expect(delivered).toContain('expectedArtifactVersionId=version-1 expectedRevision=4')
    expect(delivered).toContain('task=private-task-summary-marker')
    expect(delivered).toContain('- private-step-title-marker: not_started')
    expect(delivered).toContain('an authoritative summary of the Plan as read for this request')
    expect(delivered).toContain('do not guarantee that the Plan remained unchanged')
    expect(delivered).toContain('report it as a blocker instead of guessing')
    expect(delivered).toContain('earlier file contents may be stale')
    expect(delivered).toMatch(/do not repeat generation, approval,? or (?:a )?status update/i)
  })

  it('preserves a committed step update when Plan file refresh fails', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('disk unavailable')
    })
    const harness = createHarness({
      initialProjection: approvedProjection(4),
      contextFiles: { refresh }
    })

    const result = await harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'updateStepStatus',
      input: { title: 'private-step-title-marker', status: 'in_progress' }
    })

    expect(result).toMatchObject({
      changed: true,
      projection: {
        approval: 'approved',
        lifecycle: 'in_progress',
        stepStates: { 'private-step-title-marker': { status: 'in_progress' } }
      },
      planContext: expect.stringContaining('earlier file contents may be stale')
    })
    const planContext = (result as { planContext?: unknown }).planContext
    expect(planContext).toEqual(expect.stringContaining('does not undo committed Plan changes'))
    expect(planContext).toEqual(
      expect.stringMatching(/do not repeat generation, approval,? or (?:a )?status updates?/i)
    )
    expect(planContext).not.toEqual(expect.stringContaining('authoritative summary'))
    expect(planContext).not.toEqual(expect.stringContaining('protected Plan context'))
    expect(refresh).toHaveBeenCalledWith('project-1', 'session-1')
    expect(loggerSpies.error).toHaveBeenCalledWith(
      'Session Plan context file refresh failed',
      expect.any(Object)
    )
  })

  it('does not commit a step update after its Plan RPC interaction is cancelled', async () => {
    const updateEntered = Promise.withResolvers<void>()
    const continueUpdate = Promise.withResolvers<void>()
    const harness = createHarness({
      initialProjection: approvedProjection(4),
      beforeUpdateAuthorization: async () => {
        updateEntered.resolve()
        await continueUpdate.promise
      }
    })
    const controller = new AbortController()
    const update = harness.workflow.call({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'updateStepStatus',
      input: { title: 'private-step-title-marker', status: 'in_progress' },
      signal: controller.signal
    })
    await updateEntered.promise

    harness.setProjection({
      ...approvedProjection(8),
      artifactId: 'artifact-2',
      artifactVersionId: 'version-2',
      artifactChecksum: 'b'.repeat(64)
    })
    controller.abort()
    harness.sessionInteractions.release(harness.interaction)
    continueUpdate.resolve()

    await expect(update).rejects.toMatchObject({ code: 'interaction-mismatch' })
    await expect(harness.workflow.projection('project-1', 'session-1')).resolves.toMatchObject({
      artifactVersionId: 'version-2',
      revision: 8,
      stepStates: { 'private-step-title-marker': { status: 'not_started' } }
    })
  })

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

  it('reconstructs a real service projection while a started peer delegation has a next step', async () => {
    const interactions = new SessionPlanInteractionOwner()
    const sessionInteractions = new AcpSessionInteractionOwner()
    const document = {
      schema_version: 1 as const,
      task_summary: 'Analyze two work tracks in parallel',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Cohorts',
              steps: [
                { title: 'Validate cohorts', description: 'Validate the cohort boundaries.' },
                { title: 'Compare cohorts', description: 'Compare the validated cohorts.' }
              ]
            },
            {
              name: 'Evidence',
              steps: [
                { title: 'Find evidence', description: 'Find the relevant evidence.' },
                { title: 'Review evidence', description: 'Review the collected evidence.' }
              ]
            }
          ]
        }
      ],
      desired_outputs: ['Analysis result'],
      feasibility: { confidence: 'high' as const, rationale: 'Inputs are available.' }
    }
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
    const service = new PlanService({
      interactions,
      writeArtifactForExecution: vi.fn(),
      readArtifactVersion: vi.fn(async () => ({ content, checksum })),
      readRuntimeContext: vi.fn(async () => context),
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
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1'
    }
    const cohortRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: 4,
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
    const evidenceFound = await service.updateStepStatus({
      ...identity,
      expectedRevision: cohortBlocked.projection.revision,
      title: 'Find evidence',
      status: 'completed'
    })

    expect(evidenceFound.projection).toMatchObject({
      lifecycle: 'in_progress',
      stepStates: {
        'Validate cohorts': { status: 'blocked' },
        'Compare cohorts': { status: 'not_run' },
        'Find evidence': { status: 'completed' },
        'Review evidence': { status: 'not_started' }
      }
    })

    const containsMessageOnActiveBranch = vi.fn(async () => true)
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
        publication: { pushEvent: vi.fn() },
        sessionEnvironment: { projectId: vi.fn(() => 'project-1') }
      } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2]
    )

    await expect(
      workflow.prompt.preflight(
        { sessionId: 'session-1', text: 'Continue with the peer work track.' },
        { kind: 'user' }
      )
    ).resolves.toMatchObject({
      active: {
        artifactVersionId: 'version-1',
        revision: evidenceFound.projection.revision,
        lifecycle: 'in_progress',
        stepStates: { 'Review evidence': { status: 'not_started' } }
      }
    })
    expect(containsMessageOnActiveBranch).toHaveBeenCalledWith('project-1', 'session-1', 'prompt-1')

    const reviewRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: evidenceFound.projection.revision,
      title: 'Review evidence',
      status: 'in_progress'
    })
    const reviewCompleted = await service.updateStepStatus({
      ...identity,
      expectedRevision: reviewRunning.projection.revision,
      title: 'Review evidence',
      status: 'completed'
    })

    expect(reviewCompleted.projection.lifecycle).toBe('blocked')
    await expect(
      workflow.prompt.preflight(
        { sessionId: 'session-1', text: 'Continue after the peer work settled.' },
        { kind: 'user' }
      )
    ).resolves.toEqual({})
  })

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
    const storageRoot = await createTemporaryRoot()
    const pending = pendingProjection()
    const harness = createHarness({
      initialProjection: pending,
      contextFileStorageRoot: storageRoot,
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
    expect(admitted.source?.kind).toBe('file-reference')
    if (admitted.source?.kind !== 'file-reference') throw new Error('Expected file reference.')
    expect(admitted.source.reference).toContain('OPEN_SCIENCE_INPUT_DIR')
    expect(admitted.source.reference).toContain('session-plan/current.json')
    await expect(
      readFile(
        join(
          getNotebookInputRoot(storageRoot, 'project-1', 'session-1'),
          'session-plan',
          'current.json'
        ),
        'utf8'
      ).then(JSON.parse)
    ).resolves.toMatchObject({
      active: false,
      approval: 'pending',
      artifactVersionId: 'version-1',
      document: { task_summary: 'private-task-summary-marker' }
    })
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

  it('attaches the read-only Plan record reference to a rejected delivery review', async () => {
    const storageRoot = await createTemporaryRoot()
    const rejected = {
      ...pendingProjection(),
      revision: 5,
      approval: 'rejected' as const,
      lifecycle: 'rejected' as const
    }
    const harness = createHarness({
      initialProjection: rejected,
      contextFileStorageRoot: storageRoot,
      deliveryContext: {
        delivery: {
          commandId: 'delivery-1',
          kind: 'rejected-plan',
          state: 'delivering',
          originatingPromptMessageId: 'prompt-1',
          createdAt: 42
        },
        projection: rejected
      }
    })

    const preflight = await harness.workflow.prompt.preflight(
      { sessionId: 'session-1', text: 'Review the rejected Plan.' },
      {
        kind: 'app-continuation',
        planDelivery: { projectId: 'project-1', commandId: 'delivery-1' }
      }
    )

    expect(preflight).toMatchObject({
      protectedRejected: { approval: 'rejected', artifactVersionId: 'version-1' },
      source: {
        kind: 'file-reference',
        reference: expect.stringContaining('session-plan/current.json')
      }
    })
    await expect(
      readFile(
        join(
          getNotebookInputRoot(storageRoot, 'project-1', 'session-1'),
          'session-plan',
          'current.json'
        ),
        'utf8'
      ).then(JSON.parse)
    ).resolves.toMatchObject({
      active: false,
      approval: 'rejected',
      lifecycle: 'rejected',
      document: { task_summary: 'private-task-summary-marker' }
    })
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
    const preflight = first.prompt.preflight(
      { sessionId: 'session', text: 'Run without a Plan.' },
      { kind: 'user' }
    )
    expect(preflight).not.toBeInstanceOf(Promise)
    expect(preflight).toEqual({})
    await expect(first.projection('project', 'session')).resolves.toBeNull()
    await expect(
      first.call({ projectId: 'project', sessionId: 'session', operation: 'approve' })
    ).rejects.toMatchObject({
      code: 'plan-unavailable',
      message: expect.stringMatching(/not configured.*not attempted.*Open-Science must provide/)
    })
    await expect(
      first.respond({ projectId: 'project', sessionId: 'session', feedback: 'continue' })
    ).rejects.toMatchObject({
      code: 'plan-unavailable',
      message: expect.stringMatching(/not configured.*not attempted.*Open-Science must provide/)
    })
  })

  it('does not call Plan generation without an active prompt interaction', async () => {
    const harness = createHarness()
    harness.sessionInteractions.release(harness.interaction)

    await expect(
      harness.workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
    ).rejects.toMatchObject({
      code: 'interaction-mismatch',
      message: expect.stringMatching(
        /No active prompt interaction.*not attempted.*Open-Science.*active interaction/
      )
    })
    expect(harness.generate).not.toHaveBeenCalled()
  })

  it('does not call Plan generation when the active prompt has no durable Message identity', async () => {
    const harness = createHarness({ durablePromptMessageId: null })

    await expect(
      harness.workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
    ).rejects.toMatchObject({
      code: 'interaction-mismatch',
      message: expect.stringMatching(
        /no durable Message identity.*not attempted.*Open-Science must establish/
      )
    })
    expect(harness.generate).not.toHaveBeenCalled()
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

describe('explicit unavailable Plan recovery ownership', () => {
  const identity = {
    projectId: 'project-1',
    sessionId: 'session-1',
    artifactVersionId: 'version-1',
    expectedRevision: 1
  }
  it('tombstones the readable Plan record after an explicit discard commits', async () => {
    const storageRoot = await createTemporaryRoot()
    const harness = createHarness({
      initialProjection: approvedProjection(1),
      contextFileStorageRoot: storageRoot
    })
    const contextPath = join(
      getNotebookInputRoot(storageRoot, 'project-1', 'session-1'),
      'session-plan',
      'current.json'
    )
    await harness.workflow.prompt.preflight(
      { sessionId: 'session-1', text: 'Continue.' },
      { kind: 'user' }
    )
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      active: true,
      artifactVersionId: 'version-1'
    })
    harness.sessionInteractions.release(harness.interaction)

    await expect(harness.workflow.discardUnavailable(identity)).resolves.toEqual({ revision: 2 })
    await expect(readFile(contextPath, 'utf8').then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      active: false
    })
  })

  it('allows restored recovery on the active branch without a live prompt', async () => {
    const harness = createHarness()
    harness.sessionInteractions.release(harness.interaction)
    await expect(harness.workflow.discardUnavailable(identity)).resolves.toMatchObject({
      revision: expect.any(Number)
    })
    expect(harness.containsMessageOnActiveBranch).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      'prompt-1'
    )
  })
  it('rejects cross-branch recovery without releasing the waiter', async () => {
    const harness = createHarness({ containsOriginatingMessage: false })
    const approval = harness.interactions
      .parkApproval('session-1', 'prompt-1')
      .catch(() => undefined)
    const token = harness.interactions.approvalTokenFor('session-1')
    await expect(harness.workflow.discardUnavailable(identity)).rejects.toMatchObject({
      code: 'interaction-mismatch'
    })
    expect(harness.interactions.approvalTokenFor('session-1')).toBe(token)
    harness.interactions.rejectApproval('session-1', 'test cleanup')
    await approval
  })
  it('releases only the parked approval after successful persistence', async () => {
    const harness = createHarness()
    const approval = harness.interactions
      .parkApproval('session-1', 'prompt-1')
      .catch((error: unknown) => error)
    await harness.workflow.discardUnavailable(identity)
    expect(await approval).toMatchObject({ message: 'The unavailable Session Plan was discarded.' })
  })
  it('does not discard during an executing prompt or after a replacement claims the Session', async () => {
    const harness = createHarness()
    await expect(harness.workflow.discardUnavailable(identity)).rejects.toMatchObject({
      code: 'interaction-mismatch'
    })
    expect(harness.discardUnavailable).not.toHaveBeenCalled()
    harness.sessionInteractions.release(harness.interaction)
    harness.containsMessageOnActiveBranch.mockImplementation(async () => {
      harness.sessionInteractions.claim({
        sessionId: 'session-1',
        kind: 'prompt',
        promptMessageId: 'replacement'
      })
      return true
    })
    await expect(harness.workflow.discardUnavailable(identity)).rejects.toMatchObject({
      code: 'interaction-mismatch'
    })
  })
})

describe('Agent-visible committed Plan decisions', () => {
  it.each(['begin', 'resolve', 'clear'] as const)(
    'preserves a committed decision when %s fails through MCP',
    async (stage) => {
      const harness = createHarness()
      harness.interactions.authorizeAgentDecision({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: harness.interaction.sequence
      })
      const secret = 'synthetic-secret-' + 'x'.repeat(8000)
      if (stage === 'begin') harness.deliveries.begin.mockRejectedValueOnce(new Error(secret))
      if (stage === 'resolve')
        vi.spyOn(harness.interactions, 'resolveApproval').mockImplementationOnce(() => {
          throw new Error(secret)
        })
      if (stage === 'clear') harness.deliveries.clear.mockRejectedValueOnce(new Error(secret))
      const root = await createTemporaryRoot()
      const notebook = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'project-1',
        repository: new NotebookRunRepository(root)
      })
      const rpc = new NotebookLocalRpcServer(notebook, {
        transport: 'tcp',
        planService: { call: harness.workflow.call }
      })
      const connection = await rpc.issuePlanConnection('session-1', 'project-1')
      const server = createPlanMcpServerForEnvironment({
        ...connection,
        sessionId: 'session-1',
        projectId: 'project-1'
      })
      const client = new Client({ name: 'plan-contract-test', version: '1' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      try {
        const response = await client.callTool({
          name: 'generate_plan',
          arguments: { decision: 'approved' }
        })
        expect(response.isError).not.toBe(true)
        const text = (response.content as Array<{ type: string; text: string }>)[0].text
        const result = JSON.parse(text)
        expect(result).toMatchObject({
          kind: 'decision',
          decision: 'approved',
          artifactVersionId: 'version-1',
          deliveryCommandId: 'receipt-1',
          revision: 2
        })
        expect(result.deliveryWarning).toContain('decision is committed')
        expect(result.deliveryWarning).toContain('Do not repeat')
        expect(text).not.toContain('synthetic-secret')
        expect(text.length).toBeLessThan(2048)
        expect(harness.respond).toHaveBeenCalledOnce()
        await expect(harness.workflow.projection('project-1', 'session-1')).resolves.toMatchObject({
          approval: 'approved'
        })
      } finally {
        await client.close()
        await server.close()
        connection.release?.()
        await rpc.close()
      }
    }
  )
  it('does not advise approving a rejected Plan', async () => {
    const harness = createHarness({
      initialProjection: { ...pendingProjection(), approval: 'rejected', lifecycle: 'rejected' }
    })
    await expect(
      harness.workflow.call({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'private-step-title-marker', status: 'in_progress' }
      })
    ).rejects.toMatchObject({
      code: 'plan-not-approved',
      message: expect.stringContaining('Do not update or approve it again')
    })
  })
})
