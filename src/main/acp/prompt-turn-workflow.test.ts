import type { ActiveSession, PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi, type Mock } from 'vitest'

import type { AcpPromptRequest } from '../../shared/acp'
import {
  AcpPromptTurnWorkflow,
  type AcpActivatedPromptTurn,
  type AcpPromptTurnWorkflowOptions
} from './prompt-turn-workflow'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { TurnSkillHandle } from './turn-skill-owner'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
type Harness = {
  admitPlan: Mock<AcpPromptTurnWorkflowOptions['admitPlan']>
  authorize: Mock<AcpPromptTurnWorkflowOptions['skills']['authorize']>
  continueTurn: Mock<AcpPromptTurnWorkflowOptions['continueTurn']>
  interactions: {
    current: Mock<AcpSessionInteractionOwner['current']>
    reservePrompt: Mock<AcpSessionInteractionOwner['reservePrompt']>
    activatePrompt: Mock<AcpSessionInteractionOwner['activatePrompt']>
    release: Mock<AcpSessionInteractionOwner['release']>
  }
  journal: string[]
  owner: AcpSessionInteractionOwner
  preflightPlan: Mock<AcpPromptTurnWorkflowOptions['preflightPlan']>
  resumeAfterReload: Mock<AcpPromptTurnWorkflowOptions['resumeAfterReload']>
  setSession: (replacement: ActiveSession) => void
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

const createHarness = (
  input: {
    authorize?: () => TurnSkillHandle | Promise<TurnSkillHandle>
    preflightPlan?: AcpPromptTurnWorkflowOptions['preflightPlan']
    onPromptStarted?: () => void
  } = {}
): Harness => {
  const journal: string[] = []
  const owner = new AcpSessionInteractionOwner()
  let session = { sessionId: 'provider-1' } as ActiveSession
  const snapshot = (): {
    cwd: string
    specialistId: string
    permissionProfile: { selectedProfile: 'ask' }
  } => ({
    cwd: '/session',
    specialistId: 'specialist-1',
    permissionProfile: { selectedProfile: 'ask' }
  })
  const lookup = vi.fn(() => ({ aggregate: { snapshot }, attachment: { session } }))
  const interactions = {
    current: vi.fn((sessionId: string) => owner.current(sessionId)),
    reservePrompt: vi.fn((request: Parameters<typeof owner.reservePrompt>[0]) => {
      journal.push('reserve')
      return owner.reservePrompt(request)
    }),
    activatePrompt: vi.fn((scope: Parameters<typeof owner.activatePrompt>[0]) => {
      journal.push('activate')
      return owner.activatePrompt(scope)
    }),
    release: vi.fn((scope: Parameters<typeof owner.release>[0]) => owner.release(scope))
  }
  const authorize = vi.fn(() => {
    journal.push('authorize')
    return input.authorize?.() ?? skillHandle()
  })
  const preflightPlan = vi.fn((request: AcpPromptRequest) => {
    journal.push('preflight')
    return input.preflightPlan?.(request) ?? {}
  })
  const admitPlan = vi.fn(() => {
    journal.push('admit')
    return {}
  })
  const continueTurn = vi.fn(async (_turn: AcpActivatedPromptTurn): Promise<PromptResponse> => {
    void _turn
    journal.push('continue')
    return { stopReason: 'end_turn' }
  })
  const resumeAfterReload = vi.fn(async () => ({ contextReset: false }))
  const workflow = new AcpPromptTurnWorkflow({
    registry: {
      lookup,
      select: vi.fn(() => journal.push('select'))
    },
    interactions,
    skills: { authorize },
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
    emitState: vi.fn(() => journal.push('state')),
    continueTurn
  } as unknown as AcpPromptTurnWorkflowOptions)
  return {
    admitPlan,
    authorize,
    continueTurn,
    interactions,
    journal,
    owner,
    preflightPlan,
    resumeAfterReload,
    setSession: (replacement: ActiveSession) => (session = replacement),
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
  it('admits one user turn in owner order and transfers its opaque handles', async () => {
    const harness = createHarness()

    const turn = harness.workflow.run(request(), {
      kind: 'user',
      promptAttemptId: 'attempt-1'
    })

    // Ordinary prompts reserve and publish admission callbacks synchronously; callers observe both
    // before awaiting the provider result.
    expect(harness.interactions.reservePrompt).toHaveBeenCalledOnce()
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
      'continue'
    ])
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.continueTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ sessionId: 's1' }),
        mode: { kind: 'user', promptAttemptId: 'attempt-1' },
        interaction: expect.objectContaining({ kind: 'prompt', promptMessageId: 'message-1' })
      })
    )
  })

  it('propagates app-continuation mode and its originating turn token unchanged', async () => {
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

    expect(harness.continueTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        request: continuation,
        mode: { kind: 'app-continuation', promptAttemptId: 'attempt-2' },
        interaction: expect.objectContaining({ turnToken: 'origin-turn' })
      })
    )
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
    expect(harness.continueTurn).not.toHaveBeenCalled()
  })

  it('refreshes reservation, session, and replay context after a Skill reload', async () => {
    const harness = createHarness({ authorize: () => skillHandle('reload') })
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
    expect(harness.continueTurn.mock.calls[0][0].session).toBe(reloaded)
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
    expect(harness.continueTurn).toHaveBeenCalledOnce()
    expect(harness.journal.slice(-3)).toEqual(['start', 'state', 'continue'])
  })
})
