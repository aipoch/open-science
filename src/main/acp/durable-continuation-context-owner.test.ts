import { describe, expect, it, vi } from 'vitest'

import {
  createLinearConversationGraph,
  forkConversationAfterActivity,
  synchronizeActiveConversationActivities,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import { applyRuntimeSessionEvents } from '../../shared/runtime-session-projection'
import { normalizeSessionFile } from '../../shared/session-persistence'
import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../shared/session-persistence'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { AcpDurableContinuationContextOwner } from './durable-continuation-context-owner'

const message = (
  id: string,
  content: string,
  parts?: PersistedChatMessage['parts']
): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  ...(parts ? { parts } : {}),
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
})

const createSession = (
  messages: PersistedChatMessage[],
  graphMessages = messages
): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Restored task',
  cwd: '/workspace',
  status: 'waiting-for-user',
  messages,
  conversationGraph: createLinearConversationGraph({
    sessionId: 'pending-session',
    messages: graphMessages,
    frameworkId: 'claude-code',
    createdAt: 1,
    updatedAt: 1
  }),
  createdAt: 1,
  updatedAt: 1
})

const pendingChoice = (overrides: Partial<PersistedToolActivity> = {}): PersistedToolActivity => ({
  id: 'tool-choice-1',
  kind: 'tool',
  title: 'Choose an approach',
  status: 'in_progress',
  sortIndex: 0,
  eventIds: [],
  promptMessageId: 'prompt-active',
  elicitation: {
    message: 'Choose an approach',
    fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
    state: 'pending',
    durable: {
      kind: 'agent-user-choice',
      requestId: 'choice-1',
      promptMessageId: 'prompt-active'
    }
  },
  createdAt: 2,
  updatedAt: 2,
  ...overrides
})

const createOwner = (session: PersistedChatSession): AcpDurableContinuationContextOwner =>
  new AcpDurableContinuationContextOwner({
    loadSessionForContinuation: vi.fn(async () => structuredClone(session))
  })

const setActivities = (
  session: PersistedChatSession,
  activities: PersistedToolActivity[]
): void => {
  session.activities = activities
  session.conversationGraph = structuredClone(
    synchronizeActiveConversationActivities(session.conversationGraph!, activities, [])
  )
}

describe('AcpDurableContinuationContextOwner', () => {
  it.each([
    { providerStopped: false, approvedPlan: false, previouslyRestored: false },
    { providerStopped: true, approvedPlan: false, previouslyRestored: false },
    { providerStopped: false, approvedPlan: true, previouslyRestored: false },
    { providerStopped: false, approvedPlan: false, previouslyRestored: true },
    { providerStopped: false, approvedPlan: true, previouslyRestored: true }
  ])(
    'answers a persisted question after restart (stopped: $providerStopped, approved Plan: $approvedPlan, previously restored: $previouslyRestored)',
    async ({ providerStopped, approvedPlan, previouslyRestored }) => {
      const initial = createSession([message('prompt-active', 'Choose the next step.')])
      initial.runtimeTranscriptOwner = 'main'
      initial.status = 'running'
      initial.activeRun = { promptMessageId: 'prompt-active', startedAt: 1 }
      if (approvedPlan) {
        initial.runtimeContext = {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'plan-1',
            artifactVersionId: 'plan-version-1',
            artifactChecksum: 'a'.repeat(64),
            originatingPromptMessageId: 'prompt-active',
            approval: 'approved',
            stepStatuses: {}
          }
        }
      }
      const graph = initial.conversationGraph!
      const scope = {
        promptMessageId: 'prompt-active',
        agentFrameId: graph.rootFrameId,
        messageBranchId: graph.branches[0].id,
        runtimeSegmentId: graph.runtimeSegments[0].id
      }
      // Persist the same public tool event used by app-owned and native durable questions.
      // Closing the app does not require the provider to have emitted its final stop first.
      const projected = applyRuntimeSessionEvents(initial, scope, [
        {
          id: 'question-event',
          timestamp: 2,
          sessionId: initial.id,
          promptMessageId: scope.promptMessageId,
          kind: 'tool',
          level: 'info',
          toolCallId: 'tool-choice-1',
          title: 'Choose an approach',
          status: 'in_progress',
          elicitation: pendingChoice().elicitation
        },
        ...(providerStopped
          ? [
              {
                id: 'stop-event',
                timestamp: 3,
                sessionId: initial.id,
                promptMessageId: scope.promptMessageId,
                kind: 'stop' as const,
                level: 'info' as const,
                text: 'end_turn'
              }
            ]
          : [])
      ])
      // Older releases could save their interrupted/error or approved-Plan/idle projection.
      if (previouslyRestored) {
        projected.status = approvedPlan ? 'idle' : 'error'
        projected.activeRun = undefined
        if (!approvedPlan) {
          projected.error = 'Session was interrupted before the app closed.'
          projected.resumeRecovery = {
            kind: 'resume-required',
            cause: 'app-restart',
            promptMessageId: 'prompt-active'
          }
        }
      }
      let restored = normalizeSessionFile(JSON.parse(JSON.stringify(projected)))!
      expect(restored.activities?.[0].elicitation?.state).toBe('pending')
      const owner = new AcpDurableContinuationContextOwner({
        loadSessionForContinuation: async () => structuredClone(restored),
        mutateRuntimeSession: async (_scope, mutate) => {
          restored = mutate(structuredClone(restored))
          return restored
        }
      })
      await expect(
        owner.prepareElicitation({
          projectId: restored.projectId,
          sessionId: restored.id,
          requestId: 'choice-1',
          toolCallId: 'tool-choice-1',
          action: 'accept',
          answers: [{ fieldId: 'question_0', value: 'Let the agent decide' }]
        })
      ).resolves.toMatchObject({ request: { requestId: 'choice-1' } })
      expect(restored.activities?.[0].elicitation?.state).toBe('answered')
    }
  )

  it('keeps a live provider run intact when decoding a pending question', () => {
    const session = createSession([message('prompt-active', 'Choose an approach.')])
    session.status = 'running'
    session.activeRun = { promptMessageId: 'prompt-active', startedAt: 1 }
    setActivities(session, [pendingChoice()])
    const decoded = normalizeSessionFile(session, { preserveRuntimeState: true })!
    expect(decoded.status).toBe('running')
    expect(decoded.activeRun).toEqual(session.activeRun)
  })

  it.each([
    'missing-flat',
    'different-fields',
    'duplicate-request',
    'older-prompt',
    'different-branch',
    'cancelled',
    'answered',
    'unrelated-error',
    'unrelated-recovery'
  ])('does not restore an unsafe pending question (%s)', async (invalid) => {
    const session = createSession([message('prompt-active', 'Choose an approach.')])
    session.status = 'running'
    session.activeRun = { promptMessageId: 'prompt-active', startedAt: 1 }
    setActivities(session, [pendingChoice()])
    if (invalid === 'missing-flat') session.activities = []
    if (invalid === 'different-fields') session.activities![0].elicitation!.message = 'Different'
    if (invalid === 'duplicate-request') {
      setActivities(session, [pendingChoice(), pendingChoice({ id: 'tool-choice-2' })])
    }
    if (invalid === 'older-prompt') {
      session.messages.push(message('prompt-new', 'Do something else.'))
      session.conversationGraph = synchronizeActiveConversationMessages(
        session.conversationGraph!,
        session.messages,
        3
      )
      session.activeRun = { promptMessageId: 'prompt-new', startedAt: 3 }
    }
    if (invalid === 'different-branch') {
      const graph = session.conversationGraph!
      graph.branches.push({
        id: 'empty-branch',
        agentFrameId: graph.activeFrameId,
        createdAt: 3,
        updatedAt: 3
      })
      graph.frames[0].activeBranchId = 'empty-branch'
    }
    if (invalid === 'cancelled' || invalid === 'answered') {
      const activity = pendingChoice()
      activity.elicitation!.state = invalid
      setActivities(session, [activity])
      session.status = 'idle'
      session.activeRun = undefined
    }
    if (invalid === 'unrelated-error' || invalid === 'unrelated-recovery') {
      session.status = 'error'
      session.activeRun = undefined
      session.error =
        invalid === 'unrelated-error'
          ? 'Provider authentication failed'
          : 'Session was interrupted before the app closed.'
      session.resumeRecovery = {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: invalid === 'unrelated-recovery' ? 'another-prompt' : 'prompt-active'
      }
    }
    const restored = normalizeSessionFile(JSON.parse(JSON.stringify(session)))!
    expect(restored.status).not.toBe('waiting-for-user')
    await expect(
      createOwner(restored).prepareElicitation({
        projectId: restored.projectId,
        sessionId: restored.id,
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Expanded' }]
      })
    ).rejects.toThrow('pending Session activity')
  })

  it('rejects an originating prompt that is no longer on the active Message Branch', async () => {
    const inactivePrompt = message('prompt-inactive', 'Use the abandoned approach.')
    const activePrompt = message('prompt-active', 'Use the revised approach.')
    const owner = createOwner(createSession([inactivePrompt, activePrompt], [activePrompt]))

    await expect(
      owner.prepare({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'prompt-inactive'
      })
    ).rejects.toThrow('active Message Branch')
  })

  it('rejects an inherited prompt that was introduced on an ancestor Branch', async () => {
    const prompt = message('prompt-active', 'Choose an approach.')
    const session = createSession([prompt])
    const graph = session.conversationGraph!
    const frame = graph.frames[0]
    const parentBranch = graph.branches[0]
    graph.branches.push({
      id: 'message-branch-revised-choice',
      agentFrameId: frame.id,
      parentBranchId: parentBranch.id,
      forkMessageId: prompt.id,
      headMessageId: prompt.id,
      createdAt: 2,
      updatedAt: 2
    })
    frame.activeBranchId = 'message-branch-revised-choice'

    await expect(
      createOwner(session).prepare({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: prompt.id
      })
    ).rejects.toThrow('active Message Branch')
  })

  it('restores an elicitation from the canonical pending Session activity', async () => {
    const session = createSession([
      message('prompt-active', 'Choose an approach.', [
        { type: 'session', sessionId: 'referenced-session', title: 'Prior analysis' }
      ])
    ])
    session.memoryEnabled = false
    setActivities(session, [pendingChoice()])

    await expect(
      createOwner(session).prepareElicitation({
        projectId: 'project-1',
        sessionId: 'session-1',
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Expanded' }]
      })
    ).resolves.toMatchObject({
      memoryEnabled: false,
      request: {
        requestId: 'choice-1',
        sessionId: 'session-1',
        toolCallId: 'tool-choice-1',
        message: 'Choose an approach',
        fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
        durable: { promptMessageId: 'prompt-active' }
      },
      provenanceContext: {
        rootFrameId: 'root-frame-pending-session',
        messageBranchId: 'message-branch-pending-session',
        promptMessageId: 'prompt-active'
      },
      referencedSessions: [
        { type: 'session', sessionId: 'referenced-session', title: 'Prior analysis' }
      ]
    })
  })

  it('commits a restored Main-owned answer before returning continuation context', async () => {
    let session = createSession([message('prompt-active', 'Choose an approach.')])
    session.runtimeTranscriptOwner = 'main'
    setActivities(session, [pendingChoice()])
    const owner = new AcpDurableContinuationContextOwner({
      loadSessionForContinuation: async () => structuredClone(session),
      mutateRuntimeSession: async (_scope, mutate) => {
        session = mutate(structuredClone(session))
        return session
      }
    })
    await owner.prepareElicitation({
      projectId: session.projectId,
      sessionId: session.id,
      requestId: 'choice-1',
      toolCallId: 'tool-choice-1',
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'Expanded' }]
    })
    expect(session.activities?.[0].elicitation).toMatchObject({
      state: 'answered',
      answers: [{ fieldId: 'question_0', value: 'Expanded' }]
    })
    expect(session.conversationGraph?.activities[0].elicitation).toEqual(
      session.activities?.[0].elicitation
    )
    await expect(
      owner.prepareElicitation({
        projectId: session.projectId,
        sessionId: session.id,
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1',
        action: 'accept'
      })
    ).rejects.toThrow('pending Session activity')
  })

  it.each(['accept', 'decline'] as const)(
    'retains the committed %s decision after restarting an unaccepted continuation',
    async (action) => {
      let session = createSession([message('prompt-active', 'Choose an approach.')])
      session.runtimeTranscriptOwner = 'main'
      setActivities(session, [pendingChoice()])
      const owner = new AcpDurableContinuationContextOwner({
        loadSessionForContinuation: async () => structuredClone(session),
        mutateRuntimeSession: async (_scope, mutate) => {
          session = mutate(structuredClone(session))
          return structuredClone(session)
        }
      })
      const answers =
        action === 'accept' ? [{ fieldId: 'question_0', value: 'Expanded' }] : undefined
      await owner.prepareElicitation({
        projectId: session.projectId,
        sessionId: session.id,
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1',
        action,
        answers
      })

      // Restart crosses the normal persisted Session decoding boundary. A failed
      // continuation must not turn a committed decision back into an unanswered question.
      await owner.rearmElicitation({
        projectId: session.projectId,
        sessionId: session.id,
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1',
        promptMessageId: 'prompt-active',
        recovery: { error: 'temporary admission failure', retryable: true }
      })
      const restarted = normalizeSessionFile(JSON.parse(JSON.stringify(session)))!
      expect(restarted.activities?.[0].elicitation?.continuationRecovery).toEqual({
        error: 'temporary admission failure'
      })
      expect(restarted.activities?.[0].elicitation?.state).toBe(
        action === 'accept' ? 'answered' : 'declined'
      )
      expect(restarted.activities?.[0].elicitation?.answers).toEqual(answers)
      expect(restarted.activities?.[0].elicitation?.respondedAt).toBe(
        session.activities?.[0].elicitation?.respondedAt
      )
      expect(restarted.conversationGraph?.activities[0].elicitation).toEqual(
        restarted.activities?.[0].elicitation
      )
    }
  )

  it('keeps ambiguous legacy pending data unchanged and permits an explicit end', async () => {
    let session = createSession([message('prompt-active', 'Choose an approach.')])
    session.runtimeTranscriptOwner = 'main'
    setActivities(session, [pendingChoice()])
    for (const item of [...session.activities!, ...session.conversationGraph!.activities]) {
      item.elicitation!.continuationPending = true
    }
    session = normalizeSessionFile(JSON.parse(JSON.stringify(session)))!
    expect(session.activities?.[0].elicitation?.state).toBe('pending')
    expect(session.activities?.[0].elicitation?.continuationRecovery).toBeUndefined()
    const owner = new AcpDurableContinuationContextOwner({
      loadSessionForContinuation: async () => structuredClone(session),
      mutateRuntimeSession: async (_scope, mutate) => {
        session = mutate(structuredClone(session))
        return structuredClone(session)
      }
    })
    await owner.prepareElicitation({
      projectId: session.projectId,
      sessionId: session.id,
      requestId: 'choice-1',
      toolCallId: 'tool-choice-1',
      action: 'cancel'
    })
    expect(session.status).toBe('idle')
    expect(session.activities?.[0].elicitation?.state).toBe('cancelled')
    expect(session.activities?.[0].elicitation?.answers).toBeUndefined()
  })

  it.each(['accept', 'decline'] as const)(
    'ends a failed %s continuation durably without changing the decision',
    async (action) => {
      let session = createSession([message('prompt-active', 'Choose an approach.')])
      session.runtimeTranscriptOwner = 'main'
      setActivities(session, [pendingChoice()])
      const owner = new AcpDurableContinuationContextOwner({
        loadSessionForContinuation: async () => structuredClone(session),
        mutateRuntimeSession: async (_scope, mutate) => {
          session = mutate(structuredClone(session))
          return structuredClone(session)
        }
      })
      const input = {
        projectId: session.projectId,
        sessionId: session.id,
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1'
      }
      const answers =
        action === 'accept' ? [{ fieldId: 'question_0', value: 'Expanded' }] : undefined
      await owner.prepareElicitation({ ...input, action, answers })
      await owner.rearmElicitation({
        ...input,
        promptMessageId: 'prompt-active',
        recovery: { error: 'The bound specialist is unavailable.' }
      })
      await owner.prepareElicitation({ ...input, action: 'cancel' })
      await owner.prepareElicitation({ ...input, action: 'cancel' })
      // A delayed finally callback and a restart must not resurrect an ended wait.
      await owner.rearmElicitation({ ...input, promptMessageId: 'prompt-active' })
      const restarted = normalizeSessionFile(JSON.parse(JSON.stringify(session)))!
      expect(restarted.status).toBe('idle')
      expect(restarted.activities?.[0].elicitation).toMatchObject({
        state: action === 'accept' ? 'answered' : 'declined'
      })
      expect(restarted.activities?.[0].elicitation?.answers).toEqual(answers)
      expect(restarted.activities?.[0].elicitation?.continuationPending).toBeUndefined()
      expect(restarted.activities?.[0].elicitation?.continuationRecovery).toBeUndefined()
    }
  )

  it('does not rearm a later question when an accepted continuation finishes', async () => {
    let session = createSession([message('prompt-active', 'Choose an approach.')])
    session.runtimeTranscriptOwner = 'main'
    const accepted = pendingChoice()
    accepted.elicitation = { ...accepted.elicitation!, state: 'answered', respondedAt: 10 }
    const next = pendingChoice({ id: 'tool-choice-2' })
    next.elicitation = {
      ...next.elicitation!,
      durable: { ...next.elicitation!.durable!, requestId: 'choice-2' },
      state: 'answered',
      continuationPending: true,
      respondedAt: 20
    }
    setActivities(session, [accepted, next])
    session.status = 'running'
    session.activeRun = { promptMessageId: 'prompt-active', startedAt: 30 }
    const before = structuredClone(session)
    const owner = new AcpDurableContinuationContextOwner({
      loadSessionForContinuation: async () => structuredClone(session),
      mutateRuntimeSession: async (_scope, mutate) => {
        session = mutate(structuredClone(session))
        return session
      }
    })
    await owner.rearmElicitation({
      projectId: session.projectId,
      sessionId: session.id,
      promptMessageId: 'prompt-active',
      requestId: 'choice-1',
      toolCallId: 'tool-choice-1'
    })
    expect(session).toEqual(before)
  })

  it.each(['accept', 'decline'] as const)(
    'preserves an unaccepted %s after failure and rejects an unproven retry',
    async (action) => {
      let session = createSession([message('prompt-active', 'Choose an approach.')])
      session.runtimeTranscriptOwner = 'main'
      setActivities(session, [pendingChoice()])
      const owner = new AcpDurableContinuationContextOwner({
        loadSessionForContinuation: async () => structuredClone(session),
        mutateRuntimeSession: async (_scope, mutate) => {
          session = mutate(structuredClone(session))
          return session
        }
      })
      const response = {
        projectId: session.projectId,
        sessionId: session.id,
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1',
        action,
        ...(action === 'accept' ? { answers: [{ fieldId: 'question_0', value: 'Expanded' }] } : {})
      }
      await owner.prepareElicitation(response)
      expect(session.activities?.[0].elicitation?.continuationPending).toBe(true)
      const committed = structuredClone(session)
      await owner.rearmElicitation({ ...response, promptMessageId: 'prompt-active' })
      expect(session.status).toBe('waiting-for-user')
      expect(session.activities?.[0].elicitation?.state).toBe(
        action === 'accept' ? 'answered' : 'declined'
      )
      await expect(owner.prepareElicitation(response)).rejects.toThrow('pending Session activity')
      await expect(
        owner.prepareElicitation({ ...response, retryContinuation: true })
      ).rejects.toThrow('cannot be retried safely')

      // No finally callback runs after process loss: the durable receipt alone restores the card.
      const restarted = normalizeSessionFile(committed)!
      expect(restarted.status).toBe('waiting-for-user')
      expect(restarted.activities?.[0].elicitation).toMatchObject({
        state: action === 'accept' ? 'answered' : 'declined'
      })
      expect(restarted.conversationGraph?.activities[0].elicitation).toEqual(
        restarted.activities?.[0].elicitation
      )
      if (action === 'accept') {
        expect(restarted.activities?.[0].elicitation?.answers).toEqual(response.answers)
      }
    }
  )

  it.each([
    ['missing', []],
    [
      'stale',
      [
        pendingChoice({
          elicitation: {
            ...pendingChoice().elicitation!,
            durable: {
              kind: 'agent-user-choice',
              requestId: 'choice-newer',
              promptMessageId: 'prompt-active'
            }
          }
        })
      ]
    ],
    ['duplicated', [pendingChoice(), pendingChoice({ id: 'tool-choice-2' })]]
  ] as const)('rejects a %s durable elicitation correlation', async (_case, activities) => {
    const session = createSession([message('prompt-active', 'Choose an approach.')])
    setActivities(session, structuredClone([...activities]))

    await expect(
      createOwner(session).prepareElicitation({
        projectId: 'project-1',
        sessionId: 'session-1',
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Expanded' }]
      })
    ).rejects.toThrow('pending Session activity')
  })

  it('rejects a flat elicitation projection that disagrees with the active graph', async () => {
    const session = createSession([message('prompt-active', 'Choose an approach.')])
    setActivities(session, [pendingChoice()])
    session.activities![0].elicitation!.message = 'Stale renderer projection'

    await expect(
      createOwner(session).prepareElicitation({
        projectId: 'project-1',
        sessionId: 'session-1',
        requestId: 'choice-1',
        toolCallId: 'tool-choice-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Expanded' }]
      })
    ).rejects.toThrow('pending Session activity')
  })

  it.each(['single', 'multi', 'skipped', 'decline'] as const)(
    'validates an inherited revision fork and creates Main-owned identities (%s)',
    async (scenario) => {
      const multiSelect = scenario === 'multi'
      const skipped = scenario === 'skipped' || scenario === 'decline'
      const prompt = message('prompt-active', 'Choose an approach.')
      const preamble: PersistedChatMessage = {
        id: 'agent-question-preamble',
        role: 'agent',
        content: 'Please choose one option.',
        status: 'complete',
        responseToMessageId: prompt.id,
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
      let durable = createSession([prompt, preamble])
      const answeredChoice = pendingChoice({
        status: 'completed',
        elicitation: {
          ...pendingChoice().elicitation!,
          state: 'answered',
          answers: [{ fieldId: 'question_0', value: 'Minimal' }]
        }
      })
      const selected = ['A, B', 'Quote " and newline\nend']
      if (multiSelect) {
        answeredChoice.elicitation!.fields[0] = {
          id: 'question_0',
          label: 'Approach',
          kind: 'multi-select',
          options: selected.map((label) => ({ label, value: label }))
        }
        answeredChoice.elicitation!.answers = [{ fieldId: 'question_0', value: [selected[0]] }]
      }
      if (skipped) {
        answeredChoice.elicitation!.fields = [
          {
            id: 'question_0',
            label: 'Approach',
            description: 'Which approach?',
            kind: 'single-select',
            options: [
              { label: 'Minimal', value: 'Minimal' },
              { label: 'Expanded', value: 'Expanded' }
            ]
          },
          { id: 'question_0_custom', label: 'Other', kind: 'text' }
        ]
      }
      setActivities(durable, [answeredChoice])
      const graph = durable.conversationGraph!
      const frame = graph.frames[0]
      const rootBranch = graph.branches[0]
      graph.branches.push({
        id: 'message-branch-intermediate',
        agentFrameId: frame.id,
        parentBranchId: rootBranch.id,
        forkMessageId: preamble.id,
        headMessageId: preamble.id,
        createdAt: 3,
        updatedAt: 3
      })
      frame.activeBranchId = 'message-branch-intermediate'
      durable.conversationGraph = forkConversationAfterActivity(
        graph,
        preamble.id,
        answeredChoice.id,
        'message-branch-revision',
        4
      )
      durable.activities = []
      durable.status = 'idle'
      const revisionInput = {
        projectId: 'project-1',
        sessionId: 'session-1',
        requestId: 'choice-1',
        toolCallId: 'renderer-forged-revision-tool',
        action: scenario === 'decline' ? ('decline' as const) : ('accept' as const),
        answers: skipped
          ? [{ fieldId: 'question_0', status: 'skipped' as const }]
          : [{ fieldId: 'question_0', value: multiSelect ? selected : 'Expanded' }],
        replacePreviousAnswer: true
      }
      const invalidActivityOwner = structuredClone(durable)
      invalidActivityOwner.conversationGraph!.activities.find(
        (activity) => activity.id === 'tool-choice-1'
      )!.messageBranchId = 'message-branch-revision'
      await expect(
        createOwner(invalidActivityOwner).prepareElicitation(revisionInput)
      ).rejects.toThrow('active Session Branch')

      const appendUserMessageToInteraction = async (
        command: Parameters<SessionPersistenceCoordinator['appendUserMessageToInteraction']>[0]
      ): Promise<PersistedChatMessage> => {
        const staleAuthority = structuredClone(durable)
        staleAuthority.conversationGraph!.activities.find(
          (activity) => activity.id === 'tool-choice-1'
        )!.elicitation!.fields[0].label = 'Changed concurrently'
        expect(() => command.beforePersist?.(staleAuthority)).toThrow(
          'revision authority changed before commit'
        )
        command.beforePersist?.(structuredClone(durable))
        const revisedPrompt: PersistedChatMessage = {
          id: 'prompt-revision',
          role: 'user',
          content: command.content,
          status: 'complete',
          responseToMessageId: command.interactionId,
          eventIds: [],
          createdAt: 4,
          updatedAt: 4
        }
        durable = {
          ...durable,
          messages: [...durable.messages, revisedPrompt],
          conversationGraph: synchronizeActiveConversationMessages(
            durable.conversationGraph!,
            [...durable.messages, revisedPrompt],
            4
          ),
          updatedAt: 4
        }
        return structuredClone(revisedPrompt)
      }
      const owner = new AcpDurableContinuationContextOwner({
        loadSessionForContinuation: vi.fn(async () => structuredClone(durable)),
        appendUserMessageToInteraction: vi.fn(appendUserMessageToInteraction)
      })

      const prepared = await owner.prepareElicitation(revisionInput)

      expect(prepared.request).toMatchObject({
        requestId: 'choice-1',
        sessionId: 'session-1',
        toolCallId: expect.stringMatching(/^ask-user-question-revision-/),
        durable: { promptMessageId: 'prompt-revision' }
      })
      expect(prepared.request.toolCallId).not.toBe('renderer-forged-revision-tool')
      expect(prepared.provenanceContext).toMatchObject({
        messageBranchId: 'message-branch-revision',
        promptMessageId: 'prompt-revision'
      })
      if (skipped) {
        expect(durable.messages.at(-1)?.content).toContain('Which approach?')
        expect(durable.messages.at(-1)?.content).toContain('"status":"skipped"')
      }
      expect(durable.messages.at(-1)).toMatchObject({
        id: 'prompt-revision',
        responseToMessageId: 'agent-question-preamble',
        content: expect.stringContaining(
          skipped
            ? 'does not imply consent or authorization'
            : multiSelect
              ? `Approach: ${JSON.stringify(selected)}`
              : 'Approach: Expanded'
        )
      })
    }
  )
})
