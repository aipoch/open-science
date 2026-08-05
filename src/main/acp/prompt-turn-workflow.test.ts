import type { ActiveSession, PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi, type Mock } from 'vitest'

import type { AcpPromptRequest } from '../../shared/acp'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { opencodeFramework } from '../agent-framework'
import type { ArtifactTurnHandle } from './artifact-turn-owner'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import type { ContextUsageTurnHandle } from './context-usage-tracker'
import type { ReadyPreparedPromptHandle } from './prompt-preparation-owner'
import { AcpPromptTurnWorkflow, type AcpPromptTurnWorkflowOptions } from './prompt-turn-workflow'
import { AcpSessionAggregate } from './session-aggregate'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { TurnSkillHandle } from './turn-skill-owner'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
type Harness = {
  admitPlan: Mock<AcpPromptTurnWorkflowOptions['admitPlan']>
  artifacts: {
    open: Mock<AcpPromptTurnWorkflowOptions['artifacts']['open']>
    promptMessageIdFor: Mock<AcpPromptTurnWorkflowOptions['artifacts']['promptMessageIdFor']>
  }
  authorize: Mock<AcpPromptTurnWorkflowOptions['skills']['authorize']>
  context: ContextUsageTurnHandle
  emitSkillActivities: Mock<AcpPromptTurnWorkflowOptions['environment']['emitSkillActivities']>
  executor: Mock<AcpPromptTurnWorkflowOptions['executor']['execute']>
  finalizeTurn: Mock<AcpPromptTurnWorkflowOptions['finalizeTurn']>
  interactions: {
    current: Mock<AcpSessionInteractionOwner['current']>
    reservePrompt: Mock<AcpSessionInteractionOwner['reservePrompt']>
    activatePrompt: Mock<AcpSessionInteractionOwner['activatePrompt']>
    cancellationCheckpoint: Mock<AcpSessionInteractionOwner['cancellationCheckpoint']>
    captureTerminal: Mock<AcpSessionInteractionOwner['captureTerminal']>
    settle: Mock<AcpSessionInteractionOwner['settle']>
    release: Mock<AcpSessionInteractionOwner['release']>
  }
  journal: string[]
  onProviderPromptAccepted: Mock<
    NonNullable<AcpPromptTurnWorkflowOptions['environment']['onProviderPromptAccepted']>
  >
  owner: AcpSessionInteractionOwner
  planLifecycle: {
    beforeStop: Mock<AcpPromptTurnWorkflowOptions['planLifecycle']['beforeStop']>
  }
  preparation: Mock<AcpPromptTurnWorkflowOptions['preparation']['prepare']>
  preflightPlan: Mock<AcpPromptTurnWorkflowOptions['preflightPlan']>
  prepared: ReadyPreparedPromptHandle
  pushUserMessage: Mock<AcpPromptTurnWorkflowOptions['environment']['pushUserMessage']>
  resumeAfterReload: Mock<AcpPromptTurnWorkflowOptions['resumeAfterReload']>
  setSession: (replacement: ActiveSession) => void
  skill: TurnSkillHandle
  workflow: AcpPromptTurnWorkflow
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const skillHandle = (kind: 'continue' | 'reload' = 'continue'): TurnSkillHandle => ({
  reloadDecision: { kind },
  prepareProvider: vi.fn(async ({ promptText }) => ({ text: promptText, codexSkillInputs: [] })),
  close: vi.fn()
})

const backend: AcpBackendGenerationView = {
  framework: opencodeFramework,
  session: { model: 'test-model', modelRequired: false },
  prompt: { systemPromptAppends: [] },
  context: { supportsImageInput: false },
  adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false }
}

const planProjection = (): ActivePlanProjection => ({
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 2,
  approval: 'approved',
  lifecycle: 'approved',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Analyze the result',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary',
            steps: [{ title: 'Analyze', description: 'Analyze the result.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Result'],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { Analyze: { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
})

const createHarness = (
  input: {
    admitPlan?: AcpPromptTurnWorkflowOptions['admitPlan']
    authorize?: () => TurnSkillHandle | Promise<TurnSkillHandle>
    cancellationCheckpoint?: AcpPromptTurnWorkflowOptions['interactions']['cancellationCheckpoint']
    execute?: AcpPromptTurnWorkflowOptions['executor']['execute']
    finalizeTurn?: AcpPromptTurnWorkflowOptions['finalizeTurn']
    onPromptStarted?: () => void
    preflightPlan?: AcpPromptTurnWorkflowOptions['preflightPlan']
    prepare?: AcpPromptTurnWorkflowOptions['preparation']['prepare']
  } = {}
): Harness => {
  const journal: string[] = []
  const owner = new AcpSessionInteractionOwner()
  let session = { sessionId: 'provider-1' } as ActiveSession
  const aggregate = new AcpSessionAggregate('app-1')
  aggregate.attach({
    session,
    cwd: '/session',
    projectName: 'project-1',
    frameworkId: 'opencode',
    permissionProfile: {
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      currentModeId: 'default',
      availableModeIds: ['default'],
      fullAccessAvailable: false
    }
  })
  aggregate.setSpecialistId('specialist-1')
  aggregate.setSpecialistPrefix('[Analyst]')
  const lookup = vi.fn(() => ({
    appSessionId: 'app-1',
    generation: 1,
    aggregate,
    attachment: {
      appSessionId: 'app-1',
      providerSessionId: session.sessionId,
      generation: 1,
      session
    }
  }))
  const interactions: Harness['interactions'] = {
    current: vi.fn((sessionId: string) => owner.current(sessionId)),
    reservePrompt: vi.fn((request: Parameters<typeof owner.reservePrompt>[0]) => {
      journal.push('reserve')
      return owner.reservePrompt(request)
    }),
    activatePrompt: vi.fn((scope: Parameters<typeof owner.activatePrompt>[0]) => {
      journal.push('activate')
      return owner.activatePrompt(scope)
    }),
    cancellationCheckpoint: vi.fn(
      async (scope: Parameters<typeof owner.cancellationCheckpoint>[0]) => {
        journal.push('checkpoint')
        return input.cancellationCheckpoint?.(scope) ?? owner.cancellationCheckpoint(scope)
      }
    ),
    captureTerminal: vi.fn((...args: Parameters<typeof owner.captureTerminal>) =>
      owner.captureTerminal(...args)
    ),
    settle: vi.fn((...args: Parameters<typeof owner.settle>) => owner.settle(...args)),
    release: vi.fn((scope: Parameters<typeof owner.release>[0]) => owner.release(scope))
  }
  const skill = skillHandle()
  const authorize: Harness['authorize'] = vi.fn(() => {
    journal.push('authorize')
    return input.authorize?.() ?? skill
  })
  const preflightPlan: Harness['preflightPlan'] = vi.fn((request: AcpPromptRequest) => {
    journal.push('preflight')
    return input.preflightPlan?.(request) ?? {}
  })
  const admitPlan: Harness['admitPlan'] = vi.fn(
    (...args: Parameters<AcpPromptTurnWorkflowOptions['admitPlan']>) => {
      journal.push('admit')
      return input.admitPlan?.(...args) ?? {}
    }
  )
  const context = {
    complete: vi.fn(() => true),
    fail: vi.fn(),
    supersede: vi.fn()
  } as unknown as ContextUsageTurnHandle
  const prepared = {
    status: 'ready',
    content: 'provider content',
    skillActivityInputs: [{ name: 'Research', path: '/skills/research/SKILL.md' }],
    transferContextTurn: vi.fn(() => context),
    close: vi.fn()
  } satisfies ReadyPreparedPromptHandle
  const preparation: Harness['preparation'] = vi.fn(async (request) => {
    journal.push('prepare')
    return input.prepare?.(request) ?? prepared
  })
  const planLifecycle: Harness['planLifecycle'] = {
    beforeStop: vi.fn(async () => {
      journal.push('plan:before-stop')
    })
  }
  const onProviderPromptAccepted: Harness['onProviderPromptAccepted'] = vi.fn(() => {
    journal.push('accepted')
  })
  const executor: Harness['executor'] = vi.fn(async (request) => {
    journal.push('execute')
    if (input.execute) return input.execute(request)
    request.onAccepted()
    const response: PromptResponse = { stopReason: 'end_turn' }
    await request.beforeStop?.(response)
    request.captureStop()
    return { kind: 'stopped' as const, response, facts: {} }
  })
  const finalizeTurn: Harness['finalizeTurn'] = vi.fn(async (execution) => {
    journal.push('finalize')
    if (input.finalizeTurn) return input.finalizeTurn(execution)
    if (execution.outcome.kind === 'failed') throw execution.outcome.error
    if (execution.outcome.kind === 'not-dispatched') return { stopReason: 'cancelled' }
    return execution.outcome.response
  })
  const artifact = {} as ArtifactTurnHandle
  const artifacts: Harness['artifacts'] = {
    open: vi.fn(async () => {
      journal.push('artifact:open')
      return artifact
    }),
    promptMessageIdFor: vi.fn(() => 'fallback-message-1')
  }
  const pushUserMessage: Harness['pushUserMessage'] = vi.fn(() => {
    journal.push('event:message')
  })
  const emitSkillActivities: Harness['emitSkillActivities'] = vi.fn(
    (_sessionId, _turn, _skills, status) => {
      journal.push(`skills:${status}`)
    }
  )
  const resumeAfterReload: Harness['resumeAfterReload'] = vi.fn(async () => ({
    contextReset: false
  }))
  const workflowOptions = {
    registry: {
      lookup,
      select: vi.fn(() => journal.push('select'))
    },
    interactions,
    skills: { authorize },
    preparation: { prepare: preparation },
    executor: { execute: executor },
    environment: {
      backend: () => backend,
      tooling: () => ({ artifacts: true, notebook: true, skillImport: true }),
      bridgeSkillsAvailable: () => true,
      skillImportEnabled: () => true,
      contextEstimateInput: () => ({ frameworkId: 'opencode' }),
      selectedContextWindow: () => 128_000,
      providerAdapter: vi.fn(() => ({
        begin: vi.fn(() => ({
          finalize: vi.fn(() => ({})),
          cancel: vi.fn()
        }))
      })),
      emitSkillActivities,
      onProviderPromptAccepted,
      routeNotification: vi.fn(),
      diagnosticContext: () => ({}),
      pushUserMessage
    },
    artifacts,
    planLifecycle,
    finalizeTurn,
    currentCwd: () => '/default',
    resolveProjectName: () => 'project-1',
    preflightPlan,
    admitPlan,
    disconnectForReload: vi.fn(async () => journal.push('disconnect')),
    resumeAfterReload,
    recordAdmittedPrompt: vi.fn(() => journal.push('handoff')),
    onPromptStarted: vi.fn(() => {
      journal.push('start')
      input.onPromptStarted?.()
    }),
    emitState: vi.fn(() => journal.push('state'))
  } satisfies AcpPromptTurnWorkflowOptions
  const workflow = new AcpPromptTurnWorkflow(workflowOptions)
  return {
    admitPlan,
    artifacts,
    authorize,
    context,
    emitSkillActivities,
    executor,
    finalizeTurn,
    interactions,
    journal,
    onProviderPromptAccepted,
    owner,
    planLifecycle,
    preparation,
    preflightPlan,
    prepared,
    pushUserMessage,
    resumeAfterReload,
    setSession: (replacement: ActiveSession) => (session = replacement),
    skill,
    workflow
  }
}

const request = (): AcpPromptRequest => ({
  sessionId: 's1',
  text: 'analyze',
  forcedSkillIds: ['research'],
  provenanceContext: { promptMessageId: 'message-1' }
})

describe('AcpPromptTurnWorkflow', () => {
  it('admits and executes one user turn in owner order with its opaque handles', async () => {
    const harness = createHarness()

    const turn = harness.workflow.run(request(), {
      kind: 'user',
      promptAttemptId: 'attempt-1'
    })

    expect(harness.journal.slice(0, 9)).toEqual([
      'preflight',
      'reserve',
      'authorize',
      'activate',
      'admit',
      'select',
      'handoff',
      'start',
      'state'
    ])
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.journal).toEqual([
      'preflight',
      'reserve',
      'authorize',
      'activate',
      'admit',
      'select',
      'handoff',
      'start',
      'state',
      'artifact:open',
      'checkpoint',
      'prepare',
      'event:message',
      'skills:in_progress',
      'execute',
      'accepted',
      'skills:completed',
      'plan:before-stop',
      'finalize'
    ])
    const execution = harness.finalizeTurn.mock.calls[0][0]
    expect(execution).toMatchObject({
      artifact: expect.any(Object),
      context: harness.context,
      prepared: harness.prepared,
      skillInputs: [{ name: 'Research', path: '/skills/research/SKILL.md' }],
      skillStarted: true,
      skillFinalized: true,
      outcome: { kind: 'stopped', response: { stopReason: 'end_turn' } },
      turn: {
        request: expect.objectContaining({ sessionId: 's1' }),
        mode: { kind: 'user', promptAttemptId: 'attempt-1' },
        interaction: expect.objectContaining({ promptMessageId: 'message-1' }),
        skill: harness.skill
      }
    })
  })

  it('propagates app-continuation identity without publishing its synthetic text', async () => {
    const harness = createHarness()
    const continuation = request()
    continuation.continuation = {
      kind: 'specialist-handoff',
      originatingTurnToken: 'origin-turn',
      targetName: 'Reviewer',
      completion: { kind: 'returned', value: 'done' }
    }

    await harness.workflow.run(continuation, {
      kind: 'app-continuation',
      promptAttemptId: 'attempt-2'
    })

    const execution = harness.finalizeTurn.mock.calls[0][0]
    execution.emitUserMessage()
    expect(execution.turn.interaction.turnToken).toBe('origin-turn')
    expect(harness.pushUserMessage).not.toHaveBeenCalled()
    expect(harness.onProviderPromptAccepted).toHaveBeenCalledWith('s1', 'attempt-2')
  })

  it('cannot let delayed admission clear a newer active interaction', async () => {
    const authorization = deferred<TurnSkillHandle>()
    const staleSkill = skillHandle()
    const harness = createHarness({ authorize: () => authorization.promise })
    const stale = harness.workflow.run(request(), { kind: 'user' })
    await vi.waitFor(() => expect(harness.authorize).toHaveBeenCalledOnce())
    const staleReservation = harness.interactions.reservePrompt.mock.results[0].value
    const replacement = harness.owner.activatePrompt(
      harness.owner.reservePrompt({ sessionId: 's1', kind: 'prompt' })
    )

    authorization.resolve(staleSkill)

    await expect(stale).rejects.toThrow('already running')
    expect(staleSkill.close).toHaveBeenCalledWith('failed')
    expect(harness.interactions.release).toHaveBeenCalledWith(staleReservation)
    expect(harness.owner.current('s1')).toBe(replacement)
    expect(harness.preparation).not.toHaveBeenCalled()
    expect(harness.finalizeTurn).not.toHaveBeenCalled()
  })

  it('refreshes reservation, session, and replay context after a Skill reload', async () => {
    const reloadedSkill = skillHandle('reload')
    const harness = createHarness({ authorize: () => reloadedSkill })
    const reloaded = { sessionId: 'provider-2' } as ActiveSession
    harness.resumeAfterReload.mockImplementation(async () => {
      harness.setSession(reloaded)
      return { contextReset: true }
    })
    const turn = request()
    turn.resumeFallback = { historyPreamble: 'restored transcript' }

    await harness.workflow.run(turn, { kind: 'user' })

    expect(harness.interactions.reservePrompt).toHaveBeenCalledTimes(2)
    expect(harness.resumeAfterReload).toHaveBeenCalledWith({
      sessionId: 's1',
      cwd: '/session',
      projectName: 'project-1',
      permissionProfile: 'ask'
    })
    expect(turn).toMatchObject({ contextReset: true, historyPreamble: 'restored transcript' })
    expect(harness.executor.mock.calls[0][0].session).toBe(reloaded)
  })

  it('finishes Plan preflight before reserving and admits only an activated interaction', async () => {
    const harness = createHarness()

    await harness.workflow.run(request(), { kind: 'user' })

    expect(harness.journal.indexOf('preflight')).toBeLessThan(harness.journal.indexOf('reserve'))
    expect(harness.journal.indexOf('activate')).toBeLessThan(harness.journal.indexOf('admit'))
    expect(harness.admitPlan.mock.calls[0][1]).toBe(
      harness.interactions.activatePrompt.mock.results[0].value
    )

    const rejected = createHarness({
      preflightPlan: async () => {
        throw new Error('stale Plan')
      }
    })
    await expect(rejected.workflow.run(request(), { kind: 'user' })).rejects.toThrow('stale Plan')
    expect(rejected.interactions.reservePrompt).not.toHaveBeenCalled()
  })

  it('keeps an admitted turn running when the prompt-start callback throws', async () => {
    const harness = createHarness({
      onPromptStarted: () => {
        throw new Error('renderer unavailable')
      }
    })

    await expect(harness.workflow.run(request(), { kind: 'user' })).resolves.toEqual({
      stopReason: 'end_turn'
    })
    expect(harness.finalizeTurn).toHaveBeenCalledOnce()
    expect(harness.journal.slice(6, 10)).toEqual(['handoff', 'start', 'state', 'artifact:open'])
  })

  it('finalizes a cancellation after Artifact activation without preparing or dispatching', async () => {
    const harness = createHarness({ cancellationCheckpoint: async () => 'cancelled' })

    await expect(harness.workflow.run(request(), { kind: 'user' })).resolves.toEqual({
      stopReason: 'cancelled'
    })

    expect(harness.artifacts.open).toHaveBeenCalledWith('s1', {
      promptMessageId: 'message-1'
    })
    expect(harness.preparation).not.toHaveBeenCalled()
    expect(harness.executor).not.toHaveBeenCalled()
    const execution = harness.finalizeTurn.mock.calls[0][0]
    expect(execution.outcome).toEqual({ kind: 'not-dispatched' })
    expect(execution).not.toHaveProperty('prepared')
    expect(execution).not.toHaveProperty('context')
  })

  it('turns execution failure into one finalization outcome with pending Skill state', async () => {
    const failure = new Error('provider failed')
    const harness = createHarness({
      execute: async () => {
        throw failure
      }
    })

    await expect(harness.workflow.run(request(), { kind: 'user' })).rejects.toBe(failure)

    expect(harness.finalizeTurn).toHaveBeenCalledOnce()
    const execution = harness.finalizeTurn.mock.calls[0][0]
    expect(execution).toMatchObject({
      outcome: { kind: 'failed', error: failure },
      skillStarted: true,
      skillFinalized: false
    })
    execution.emitUserMessage()
    expect(harness.pushUserMessage).toHaveBeenCalledOnce()
    expect(harness.emitSkillActivities.mock.calls.map((call) => call[3])).toEqual(['in_progress'])
    expect(harness.onProviderPromptAccepted).not.toHaveBeenCalled()
  })

  it('passes protected Plan guidance through the interaction-scoped completion gate', async () => {
    const projection = planProjection()
    const harness = createHarness({ admitPlan: () => ({ authorized: projection }) })
    const prompt = request()
    prompt.turnIntent = 'plan-first'

    await harness.workflow.run(prompt, { kind: 'user' })

    expect(harness.preparation).toHaveBeenCalledWith(
      expect.objectContaining({
        protectedContext: expect.stringContaining('artifact_version_id=plan-version-1'),
        turnPromptReminders: [expect.stringContaining('Plan mode (ACTIVE')]
      })
    )
    const interaction = harness.finalizeTurn.mock.calls[0][0].turn.interaction
    expect(harness.planLifecycle.beforeStop).toHaveBeenCalledWith('s1', interaction, {
      stopReason: 'end_turn'
    })
  })
})
