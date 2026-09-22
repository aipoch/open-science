import { describe, expect, it, vi } from 'vitest'

import {
  createLinearConversationGraph,
  forkConversationAfterActivity,
  synchronizeActiveConversationActivities,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
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
    're-presents an unaccepted %s after failure and process restart without losing its answer',
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
      expect(session.activities?.[0].elicitation?.state).toBe('pending')
      await expect(owner.prepareElicitation(response)).resolves.toBeDefined()

      // No finally callback runs after process loss: the durable receipt alone restores the card.
      const restarted = normalizeSessionFile(committed)!
      expect(restarted.status).toBe('waiting-for-user')
      expect(restarted.activities?.[0].elicitation).toMatchObject({ state: 'pending' })
      expect(restarted.conversationGraph?.activities[0].elicitation).toEqual(
        restarted.activities?.[0].elicitation
      )
      if (action === 'accept') {
        expect(restarted.activities?.[0].elicitation?.draftAnswers).toEqual(response.answers)
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

  it('validates an inherited revision fork and creates Main-owned identities', async () => {
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
      action: 'accept' as const,
      answers: [{ fieldId: 'question_0', value: 'Expanded' }],
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
    expect(durable.messages.at(-1)).toMatchObject({
      id: 'prompt-revision',
      responseToMessageId: 'agent-question-preamble',
      content: expect.stringContaining('Approach: Expanded')
    })
  })
})
