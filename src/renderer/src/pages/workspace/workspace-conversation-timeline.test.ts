import { describe, expect, it, vi } from 'vitest'

import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import { ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME } from '../../../../shared/acp'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages,
  synchronizeActiveConversationActivities
} from '../../../../shared/conversation-graph'
import type { HandoffLifecycleEvent } from '../../../../shared/handoff-lifecycle'
import {
  createWorkspaceConversationTimeline,
  resolveCurrentTurnOutcomeItem,
  resolveForkBoundaryItemId
} from './workspace-conversation-timeline'

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'prompt-1',
  role: 'user',
  content: 'Create a chart',
  status: 'complete',
  eventIds: [],
  createdAt: 100,
  updatedAt: 100,
  ...overrides
})

const activity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: 'Notebook run',
  status: 'completed',
  eventIds: [],
  sortIndex: 3,
  promptMessageId: 'prompt-1',
  createdAt: 300,
  updatedAt: 300,
  ...overrides
})

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 100,
  updatedAt: 500,
  ...overrides
})

const timelineIds = (
  input: ChatSession,
  handoffEvents: readonly HandoffLifecycleEvent[] = []
): string[] => createWorkspaceConversationTimeline(input, handoffEvents).map(({ id }) => id)

describe('workspace conversation timeline', () => {
  it('avoids a full prompt-array scan for every completed turn', () => {
    const turnCount = 250
    const messages = Array.from({ length: turnCount }, (_, index) => [
      message({ id: `prompt-${index}`, createdAt: index * 2, sortIndex: index * 2 }),
      message({
        id: `reply-${index}`,
        role: 'agent',
        responseToMessageId: `prompt-${index}`,
        createdAt: index * 2 + 1,
        sortIndex: index * 2 + 1,
        completedAt: index * 2 + 2
      })
    ]).flat()
    // Count the reported repeated scan, rather than imposing a hardware-dependent time limit.
    // The production projection remains unmocked; restore instrumentation before assertions.
    const originalForEach = Array.prototype.forEach
    let promptVisits = 0
    const scan = vi.spyOn(Array.prototype, 'forEach').mockImplementation(function (
      this: unknown[],
      callback,
      thisArg
    ) {
      const isPromptArray =
        this.length === messages.length &&
        typeof this[0] === 'string' &&
        this[0].startsWith('prompt-')
      if (isPromptArray) promptVisits += this.length
      return originalForEach.call(this, callback, thisArg)
    })
    let result: ReturnType<typeof createWorkspaceConversationTimeline>
    try {
      result = createWorkspaceConversationTimeline(session({ messages }))
    } finally {
      scan.mockRestore()
    }
    expect(result.map((item) => item.id)).toEqual(
      Array.from({ length: turnCount }, (_, index) => [
        `prompt-${index}`,
        `reply-${index}`,
        `turn-completion-reply-${index}`
      ]).flat()
    )
    expect(promptVisits).toBeLessThanOrEqual(messages.length)
  })

  it('keeps the current turn notice out of the transcript timeline', () => {
    const input = session({
      messages: [
        message({
          turnOutcome: {
            kind: 'failed',
            settledAt: 600,
            error: 'The agent failed.',
            errorReportable: true
          }
        }),
        message({
          id: 'reply-1',
          role: 'agent',
          responseToMessageId: 'prompt-1',
          sortIndex: 2,
          createdAt: 200,
          completedAt: 500,
          updatedAt: 500
        })
      ],
      activities: [activity({ sortIndex: 3, createdAt: 300, updatedAt: 300 })]
    })

    expect(timelineIds(input)).toEqual([
      'prompt-1',
      'reply-1',
      'activity-group-tool-1',
      'turn-completion-reply-1'
    ])
    expect(resolveCurrentTurnOutcomeItem(input)).toMatchObject({
      promptMessageId: 'prompt-1',
      outcome: { kind: 'failed', error: 'The agent failed.' }
    })
  })

  it('retains an earlier failed outcome after a later turn completes', () => {
    const input = session({
      messages: [
        message({ turnOutcome: { kind: 'failed', settledAt: 150, error: 'Earlier error' } }),
        message({
          id: 'prompt-2',
          sortIndex: 2,
          createdAt: 200,
          turnOutcome: { kind: 'completed', settledAt: 300 }
        })
      ]
    })
    expect(timelineIds(input)).toEqual(['prompt-1', 'turn-outcome-prompt-1', 'prompt-2'])
  })

  it('keeps the previous notice current while a new prompt is prepared but not admitted', () => {
    const input = session({
      status: 'running',
      messages: [
        message({ turnOutcome: { kind: 'failed', settledAt: 150, error: 'Earlier error' } }),
        message({ id: 'prepared-prompt', sortIndex: 2, createdAt: 200 })
      ],
      activeRun: { promptMessageId: 'prepared-prompt', startedAt: 210 },
      promptPreparation: {
        id: 'preparation-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'prepared-prompt',
        mode: 'new',
        preparedAt: 205,
        runStartedAt: 210,
        previousState: { status: 'error', error: 'Earlier error' },
        expectedState: { status: 'running' }
      }
    })

    expect(resolveCurrentTurnOutcomeItem(input)).toMatchObject({
      promptMessageId: 'prompt-1',
      outcome: { kind: 'failed', error: 'Earlier error' }
    })
    expect(timelineIds(input)).toEqual(['prompt-1', 'prepared-prompt'])
  })

  it('checks preparation before legacy Session fields can attach recovery to the new prompt', () => {
    const input = session({
      status: 'error',
      error: 'Connection lost — Resume to reconnect and continue.',
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'connection-lost',
        promptMessageId: 'prompt-1'
      },
      messages: [
        message({
          turnOutcome: {
            kind: 'interrupted',
            settledAt: 150,
            cause: 'connection-lost',
            recovery: 'resume'
          }
        }),
        message({ id: 'prepared-prompt', sortIndex: 2, createdAt: 200 })
      ],
      promptPreparation: {
        id: 'preparation-before-run',
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'prepared-prompt',
        mode: 'new',
        preparedAt: 205,
        previousState: {
          status: 'error',
          error: 'Connection lost — Resume to reconnect and continue.',
          resumeRecovery: {
            kind: 'resume-required',
            cause: 'connection-lost',
            promptMessageId: 'prompt-1'
          }
        },
        expectedState: { status: 'running' }
      }
    })

    expect(resolveCurrentTurnOutcomeItem(input)).toMatchObject({
      promptMessageId: 'prompt-1',
      outcome: { kind: 'interrupted', cause: 'connection-lost' }
    })
  })

  it('moves the previous result into history only after Main admission clears preparation', () => {
    const input = session({
      status: 'running',
      messages: [
        message({ turnOutcome: { kind: 'failed', settledAt: 150, error: 'Earlier error' } }),
        message({ id: 'admitted-prompt', sortIndex: 2, createdAt: 200 })
      ],
      activeRun: { promptMessageId: 'admitted-prompt', startedAt: 210 },
      runtimeTranscriptOwner: 'main',
      runtimeSessionAdmissions: [
        {
          executionId: 'execution-2',
          promptMessageId: 'admitted-prompt',
          promptRuntimeSegmentId: 'prompt-segment-2',
          rootFrameId: 'root',
          agentFrameId: 'agent',
          messageBranchId: 'branch',
          runtimeSegmentId: 'runtime-2'
        }
      ]
    })

    expect(resolveCurrentTurnOutcomeItem(input)).toBeUndefined()
    expect(timelineIds(input)).toEqual(['prompt-1', 'turn-outcome-prompt-1', 'admitted-prompt'])
  })

  it.each(['completed', 'failed'] as const)(
    'keeps the original Branch latest failure while editing an early %s turn',
    (kind) => {
      const early = message({
        turnOutcome:
          kind === 'completed'
            ? { kind, settledAt: 110 }
            : { kind, settledAt: 110, error: 'Early failure' }
      })
      const previous = message({
        id: 'latest-prompt',
        turnOutcome: { kind: 'failed', settledAt: 150, error: 'Original Branch failure' }
      })
      const originalGraph = createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [early, previous],
        frameworkId: 'codex',
        createdAt: 100,
        updatedAt: 150
      })
      const unrelatedGraph = synchronizeActiveConversationMessages(
        forkEditedConversationMessage(originalGraph, 'prompt-1', 'unrelated-branch', 160),
        [
          message({
            id: 'unrelated-prompt',
            turnOutcome: {
              kind: 'failed',
              settledAt: 190,
              error: 'Unrelated Branch failure'
            }
          })
        ],
        190
      )
      const restoredGraph = activateConversationBranch(
        unrelatedGraph,
        originalGraph.messages[0].introducedOnBranchId
      )
      const forked = forkEditedConversationMessage(restoredGraph, 'prompt-1', 'edited-branch', 200)
      const prepared = message({ id: 'edited-prompt', content: 'Edited prompt', createdAt: 200 })
      const graph = synchronizeActiveConversationMessages(forked, [prepared], 200)
      const input = session({
        status: 'running',
        messages: [prepared],
        conversationGraph: graph,
        activeRun: { promptMessageId: 'edited-prompt', startedAt: 210 },
        promptPreparation: {
          id: 'preparation-edit',
          projectId: 'project-1',
          sessionId: 'session-1',
          promptMessageId: 'edited-prompt',
          mode: 'new',
          preparedAt: 205,
          runStartedAt: 210,
          previousState: { status: 'error', error: 'Original Branch failure' },
          expectedState: { status: 'running' }
        }
      })

      expect(resolveCurrentTurnOutcomeItem(input)).toMatchObject({
        promptMessageId: 'latest-prompt',
        outcome: { kind: 'failed', error: 'Original Branch failure' }
      })
      expect(
        resolveCurrentTurnOutcomeItem(
          session({
            messages: [early, previous],
            conversationGraph: originalGraph,
            status: 'error',
            error: 'Original Branch failure'
          })
        )?.promptMessageId
      ).toBe('latest-prompt')
      expect(
        resolveCurrentTurnOutcomeItem({
          ...input,
          promptPreparation: undefined
        })
      ).toBeUndefined()
    }
  )

  it('retains exact Resume recovery during preparation and never gives history Resume', () => {
    const input = session({
      status: 'running',
      messages: [
        message({
          turnOutcome: {
            kind: 'interrupted',
            settledAt: 150,
            cause: 'connection-lost',
            recovery: 'resume'
          }
        })
      ],
      activeRun: { promptMessageId: 'prompt-1', startedAt: 210 },
      promptPreparation: {
        id: 'preparation-resume',
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'prompt-1',
        mode: 'resume',
        preparedAt: 205,
        runStartedAt: 210,
        previousState: {
          status: 'error',
          resumeRecovery: {
            kind: 'resume-required',
            cause: 'connection-lost',
            promptMessageId: 'prompt-1'
          }
        },
        expectedState: { status: 'running' }
      }
    })

    expect(resolveCurrentTurnOutcomeItem(input)?.promptMessageId).toBe('prompt-1')
    expect(timelineIds(input)).toEqual(['prompt-1'])
  })

  it('derives notices per Session without retaining state across navigation', () => {
    const failed = session({
      id: 'failed-session',
      messages: [message({ turnOutcome: { kind: 'failed', settledAt: 150 } })]
    })
    const clean = session({ id: 'clean-session', messages: [message({})] })

    expect(resolveCurrentTurnOutcomeItem(failed)?.promptMessageId).toBe('prompt-1')
    expect(resolveCurrentTurnOutcomeItem(clean)).toBeUndefined()
    expect(resolveCurrentTurnOutcomeItem(failed)?.promptMessageId).toBe('prompt-1')
  })

  it('keeps visible application outcomes and excludes hidden controls and advisory relays', () => {
    const failed = { kind: 'failed', settledAt: 150, error: 'Own failure' } as const
    const input = session({
      messages: [
        message({
          attribution: {
            kind: 'application',
            feature: 'reviewer',
            purpose: 'correction',
            causeReviewId: 'review-1'
          },
          turnOutcome: failed
        }),
        message({
          id: 'hidden-prompt',
          turnIntent: 'save-as-skill',
          sortIndex: 2,
          turnOutcome: failed
        }),
        message({
          id: 'relay-prompt',
          relayedFrom: { kind: 'side-chat', direction: 'to-main' },
          sortIndex: 3,
          turnOutcome: failed
        })
      ]
    })
    expect(
      createWorkspaceConversationTimeline(input)
        .filter(({ type }) => type === 'turn-outcome')
        .map(({ id }) => id)
    ).toEqual(['turn-outcome-prompt-1'])
  })

  it('does not move a hidden legacy failure onto an earlier visible prompt', () => {
    const input = session({
      status: 'error',
      error: 'Hidden failure',
      messages: [
        message({}),
        message({ id: 'hidden-prompt', turnIntent: 'save-as-skill', sortIndex: 2 })
      ]
    })
    expect(
      createWorkspaceConversationTimeline(input).filter(({ type }) => type === 'turn-outcome')
    ).toEqual([])
  })

  it('omits every historical interruption while retaining its durable messages', () => {
    const input = session({
      messages: [
        message({
          turnOutcome: {
            kind: 'interrupted',
            settledAt: 150,
            cause: 'app-restart',
            recovery: 'resume'
          }
        }),
        message({
          id: 'prompt-2',
          sortIndex: 2,
          turnOutcome: {
            kind: 'interrupted',
            settledAt: 250,
            cause: 'terminal-commit-failed',
            recovery: 'resume'
          }
        })
      ]
    })
    expect(timelineIds(input)).toEqual(['prompt-1', 'prompt-2'])
    expect(input.messages.map(({ turnOutcome }) => turnOutcome?.kind)).toEqual([
      'interrupted',
      'interrupted'
    ])
  })

  it('keeps a synthesized current legacy failure out of the transcript timeline', () => {
    const input = session({
      status: 'error',
      error: 'Legacy failure',
      messages: [
        message({}),
        message({ id: 'legacy-reply', role: 'agent', sortIndex: 2, completedAt: 300 })
      ]
    })
    expect(timelineIds(input)).toEqual(['prompt-1', 'legacy-reply', 'turn-completion-legacy-reply'])
    expect(resolveCurrentTurnOutcomeItem(input)).toMatchObject({
      promptMessageId: 'prompt-1',
      outcome: { kind: 'failed', error: 'Legacy failure' }
    })
  })

  it('ends legacy untagged ownership at the next user message, including advisory relays', () => {
    const input = session({
      status: 'error',
      error: 'Legacy failure',
      messages: [
        message({}),
        message({
          id: 'relay',
          role: 'user',
          relayedFrom: { kind: 'side-chat', direction: 'to-main' },
          sortIndex: 2
        }),
        message({ id: 'unowned-reply', role: 'agent', sortIndex: 3, completedAt: 300 })
      ]
    })
    const ids = timelineIds(input)
    expect(ids.indexOf('turn-outcome-prompt-1')).toBeLessThan(ids.indexOf('unowned-reply'))
  })

  it('keeps legacy untagged ownership across the turn own routed reply but not across a relay', () => {
    const messages = (between: Partial<ChatMessage>): ChatMessage[] => [
      message({ sortIndex: 1 }),
      message({
        id: 'tagged-reply',
        role: 'agent',
        responseToMessageId: 'prompt-1',
        sortIndex: 2,
        createdAt: 150,
        completedAt: 200
      }),
      message({ ...between, role: 'user', sortIndex: 3, createdAt: 250 }),
      message({ id: 'legacy-reply', role: 'agent', sortIndex: 4, createdAt: 300, completedAt: 400 })
    ]
    const steered = session({
      status: 'error',
      error: 'Legacy failure',
      messages: messages({ id: 'steering', responseToMessageId: 'prompt-1' })
    })
    // The steering reply belongs to prompt-1, so the later untagged reply is still its response and
    // the tagged footer stays below every row the turn owns.
    expect(timelineIds(steered)).toEqual([
      'prompt-1',
      'tagged-reply',
      'steering',
      'legacy-reply',
      'turn-completion-tagged-reply',
      'turn-completion-legacy-reply'
    ])

    const relayed = session({
      status: 'error',
      error: 'Legacy failure',
      messages: messages({
        id: 'relay',
        relayedFrom: { kind: 'side-chat', direction: 'to-main' }
      })
    })
    expect(timelineIds(relayed)).toEqual([
      'prompt-1',
      'tagged-reply',
      'turn-completion-tagged-reply',
      'relay',
      'legacy-reply',
      'turn-completion-legacy-reply'
    ])
  })

  it('places one turn completion after a tool that follows the final Agent fragment', () => {
    const input = session({
      messages: [
        message({ sortIndex: 1 }),
        message({
          id: 'reply-1',
          role: 'agent',
          content: 'Both kernels are ready. I will create the chart now.',
          responseToMessageId: 'prompt-1',
          sortIndex: 2,
          createdAt: 200,
          completedAt: 500,
          updatedAt: 500
        })
      ],
      activities: [activity({ sortIndex: 3, createdAt: 300, updatedAt: 300 })]
    })

    expect(timelineIds(input)).toEqual([
      'prompt-1',
      'reply-1',
      'activity-group-tool-1',
      'turn-completion-reply-1'
    ])
  })

  it('keeps a completion after every later activity kind owned by the Prompt', () => {
    const input = session({
      messages: [
        message({ sortIndex: 1 }),
        message({
          id: 'reply-1',
          role: 'agent',
          content: 'I will finish the remaining work.',
          responseToMessageId: 'prompt-1',
          sortIndex: 2,
          createdAt: 200,
          completedAt: 700,
          updatedAt: 700
        })
      ],
      activities: [
        activity({ id: 'ordinary-tool', sortIndex: 3, createdAt: 300, updatedAt: 300 }),
        activity({
          id: 'plan-tool',
          providerToolName: 'mcp__open-science-plan__generate_plan',
          sortIndex: 4,
          createdAt: 400,
          updatedAt: 400
        }),
        activity({
          id: 'compaction-tool',
          providerToolName: ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME,
          sortIndex: 5,
          createdAt: 500,
          updatedAt: 500
        })
      ]
    })
    const handoff: HandoffLifecycleEvent = {
      id: 'handoff-1',
      sessionId: input.id,
      sequence: 1,
      observedAt: 600,
      phase: 'continued',
      target: { kind: 'main' },
      provenance: {
        originatingTurnId: 'turn-1',
        originatingUserMessageId: 'prompt-1',
        attachmentIds: [],
        artifactIds: []
      }
    }

    expect(timelineIds(input, [handoff])).toEqual([
      'prompt-1',
      'reply-1',
      'activity-group-ordinary-tool',
      'plan-activity-plan-tool',
      'compaction-activity-compaction-tool',
      'handoff:session-1:turn-1',
      'turn-completion-reply-1'
    ])
  })

  it('does not move a completion across the next Prompt', () => {
    const input = session({
      messages: [
        message({ id: 'prompt-1', sortIndex: 1, createdAt: 100 }),
        message({
          id: 'reply-1',
          role: 'agent',
          responseToMessageId: 'prompt-1',
          sortIndex: 2,
          createdAt: 200,
          completedAt: 350,
          updatedAt: 350
        }),
        message({ id: 'prompt-2', sortIndex: 4, createdAt: 400 }),
        message({
          id: 'reply-2',
          role: 'agent',
          responseToMessageId: 'prompt-2',
          sortIndex: 6,
          createdAt: 600,
          completedAt: 700,
          updatedAt: 700
        })
      ],
      activities: [
        activity({ id: 'tool-1', promptMessageId: 'prompt-1', sortIndex: 3, createdAt: 300 }),
        activity({ id: 'tool-2', promptMessageId: 'prompt-2', sortIndex: 5, createdAt: 500 })
      ]
    })

    expect(timelineIds(input)).toEqual([
      'prompt-1',
      'reply-1',
      'activity-group-tool-1',
      'turn-completion-reply-1',
      'prompt-2',
      'activity-group-tool-2',
      'reply-2',
      'turn-completion-reply-2'
    ])
  })

  it.each([
    ['active run', { activeRun: { promptMessageId: 'prompt-1', startedAt: 100 } }],
    ['Ask-User continuation', { agentPromptInFlight: true }],
    ['waiting continuation', { status: 'waiting-for-user' as const }]
  ])('omits completion for an %s', (_label, runtimeState) => {
    const input = session({
      ...runtimeState,
      messages: [
        message({ sortIndex: 1 }),
        message({
          id: 'reply-1',
          role: 'agent',
          responseToMessageId: 'prompt-1',
          sortIndex: 2,
          createdAt: 200,
          completedAt: 300,
          updatedAt: 300
        })
      ]
    })

    expect(timelineIds(input)).not.toContain('turn-completion-reply-1')
  })

  it('omits completion for an interrupted Prompt', () => {
    const input = session({
      status: 'error',
      messages: [
        message({ interrupted: true, sortIndex: 1 }),
        message({
          id: 'reply-1',
          role: 'agent',
          status: 'error',
          responseToMessageId: 'prompt-1',
          sortIndex: 2,
          createdAt: 200,
          failedAt: 300,
          updatedAt: 300
        })
      ]
    })

    expect(timelineIds(input)).not.toContain('turn-completion-reply-1')
  })

  it('uses active-Branch Conversation Graph ownership for a historical flat activity', () => {
    const messages = [
      message({ sortIndex: 1 }),
      message({
        id: 'reply-1',
        role: 'agent',
        responseToMessageId: 'prompt-1',
        sortIndex: 2,
        createdAt: 200,
        completedAt: 400,
        updatedAt: 400
      })
    ]
    const historicalActivity = activity({
      promptMessageId: undefined,
      sortIndex: 3,
      createdAt: 300,
      updatedAt: 300
    })
    const graph = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: 'session-1',
        messages,
        frameworkId: 'codex',
        createdAt: 100,
        updatedAt: 400
      }),
      [historicalActivity],
      []
    )
    const input = session({ messages, activities: [historicalActivity], conversationGraph: graph })

    expect(timelineIds(input)).toEqual([
      'prompt-1',
      'reply-1',
      'activity-group-tool-1',
      'turn-completion-reply-1'
    ])
    expect(input.activities?.[0].promptMessageId).toBeUndefined()
  })

  it('keeps an uncorrelated legacy activity conservative instead of guessing ownership', () => {
    const input = session({
      messages: [
        message({ sortIndex: 1 }),
        message({
          id: 'reply-1',
          role: 'agent',
          responseToMessageId: 'prompt-1',
          sortIndex: 2,
          createdAt: 200,
          completedAt: 400,
          updatedAt: 400
        })
      ],
      activities: [
        activity({ promptMessageId: undefined, sortIndex: 3, createdAt: 300, updatedAt: 300 })
      ]
    })

    expect(timelineIds(input)).toEqual([
      'prompt-1',
      'reply-1',
      'turn-completion-reply-1',
      'activity-group-tool-1'
    ])
  })

  it('places completion after a later inline Subagent message from the same root Prompt', () => {
    const messages = [
      message({ sortIndex: 1 }),
      message({
        id: 'reply-1',
        role: 'agent',
        responseToMessageId: 'prompt-1',
        sortIndex: 2,
        createdAt: 200,
        completedAt: 400,
        updatedAt: 400
      })
    ]
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages,
      frameworkId: 'codex',
      createdAt: 100,
      updatedAt: 400
    })
    const root = graph.frames.find(({ id }) => id === graph.rootFrameId)!
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: root.id,
      originMessageId: 'prompt-1',
      originBindingState: 'validated',
      kind: 'delegate',
      delegateName: 'Analyst',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 150
    })
    graph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-prompt',
      createdAt: 150,
      updatedAt: 150
    })
    graph.messages.push({
      id: 'child-prompt',
      role: 'user',
      content: 'Analyze the data',
      status: 'complete',
      eventIds: [],
      agentFrameId: 'child-frame',
      introducedOnBranchId: 'child-branch',
      createdAt: 150,
      updatedAt: 150
    })
    const input = session({
      messages,
      conversationGraph: graph,
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [],
          messageCommands: [
            {
              messageId: 'subagent-update',
              requestId: 'request-1',
              sourcePrincipal: 'child-frame',
              canonicalDigest: 'a'.repeat(64),
              sourceFrameId: 'child-frame',
              targetFrameId: root.id,
              rootOriginMessageId: 'prompt-1',
              callerRootMessageId: 'prompt-1',
              rootBranchId: root.activeBranchId,
              rootBranchRevision: `${root.activeBranchId}:100`,
              direction: 'to_parent',
              disposition: 'message',
              text: 'The analysis is complete.',
              kind: 'info',
              laneSequence: 1,
              queuedAt: 300,
              receipt: { status: 'accepted', acceptedAt: 310, evidence: 'provider_prompt_accepted' }
            }
          ]
        }
      }
    })

    expect(timelineIds(input)).toEqual([
      'prompt-1',
      'reply-1',
      'subagent-message-subagent-update',
      'turn-completion-reply-1'
    ])
  })
})

describe('fork turn boundary', () => {
  const inherited = message({
    id: 'copied-answer',
    role: 'agent',
    responseToMessageId: 'prompt-1',
    sortIndex: 2,
    completedAt: 200,
    usageOrigin: { sessionId: 'ancestor', messageId: 'ancestor-answer' }
  })
  const fork = (overrides: Partial<ChatSession> = {}): ChatSession =>
    session({
      messages: [message({ sortIndex: 1 }), inherited],
      forkOrigin: {
        importId: 'copy',
        sourceProjectId: 'project-1',
        sourceSessionId: 'source',
        importedAt: 300,
        manifestChecksum: 'a'.repeat(64)
      },
      forkHeadMessageId: inherited.id,
      ...overrides
    })

  it.each([true, false])(
    'keeps the fork turn before new turns despite a late inherited footer (explicit head: %s)',
    (explicit) => {
      const input = fork({
        forkHeadMessageId: explicit ? inherited.id : undefined,
        messages: [
          message({ sortIndex: 1 }),
          inherited,
          message({ id: 'new-prompt', sortIndex: 3 })
        ],
        activities: [activity({ id: 'late-tool', sortIndex: 4 })]
      })
      const timeline = createWorkspaceConversationTimeline(input)
      expect(timeline.at(-1)?.id).toBe('turn-completion-copied-answer')
      const boundary = resolveForkBoundaryItemId(input, timeline)
      expect(boundary).toBe(inherited.id)
      expect(timeline.findIndex((item) => item.id === boundary)).toBeLessThan(
        timeline.findIndex((item) => item.id === 'new-prompt')
      )
    }
  )

  it('includes completion details while they still belong before the next turn', () => {
    const input = fork({ activities: [activity({ sortIndex: 3 })] })
    expect(resolveForkBoundaryItemId(input, createWorkspaceConversationTimeline(input))).toBe(
      'turn-completion-copied-answer'
    )
  })

  it('uses the stored local head even when another inherited message follows it', () => {
    const input = fork({
      messages: [
        inherited,
        message({
          id: 'later',
          sortIndex: 3,
          usageOrigin: { sessionId: 'other', messageId: 'other-message' }
        })
      ]
    })
    expect(resolveForkBoundaryItemId(input, createWorkspaceConversationTimeline(input))).toBe(
      'turn-completion-copied-answer'
    )
  })

  it('does not move the divider to another selected branch without the fork head', () => {
    const input = fork({
      messages: [message({ id: 'sibling', usageOrigin: inherited.usageOrigin })]
    })
    expect(
      resolveForkBoundaryItemId(input, createWorkspaceConversationTimeline(input))
    ).toBeUndefined()
    const original = fork()
    expect(resolveForkBoundaryItemId(original, createWorkspaceConversationTimeline(original))).toBe(
      'turn-completion-copied-answer'
    )
  })
})

describe('fork inherited turn outcomes', () => {
  const failed = { kind: 'failed', settledAt: 150, error: 'Provider failed' } as const
  const interrupted = {
    kind: 'interrupted',
    settledAt: 150,
    cause: 'app-restart',
    recovery: 'resume'
  } as const
  const forkOf = (
    outcome: NonNullable<ChatMessage['turnOutcome']>,
    extra: ChatMessage[] = []
  ): ChatSession =>
    session({
      messages: [
        message({ id: 'inherited-prompt', sortIndex: 1, turnOutcome: outcome }),
        message({
          id: 'inherited-answer',
          role: 'agent',
          responseToMessageId: 'inherited-prompt',
          status: 'error',
          failedAt: 150,
          sortIndex: 2
        }),
        ...extra
      ],
      forkHeadMessageId: 'inherited-answer'
    })

  it('presents an inherited failed latest turn only as a historical marker', () => {
    const input = forkOf(failed)
    expect(resolveCurrentTurnOutcomeItem(input)).toBeUndefined()
    expect(createWorkspaceConversationTimeline(input).map(({ id }) => id)).toContain(
      'turn-outcome-inherited-prompt'
    )
  })

  it('presents an inherited interrupted latest turn nowhere', () => {
    const input = forkOf(interrupted)
    expect(resolveCurrentTurnOutcomeItem(input)).toBeUndefined()
    expect(
      createWorkspaceConversationTimeline(input).some(({ type }) => type === 'turn-outcome')
    ).toBe(false)
  })

  it('keeps a failed turn from the fork itself current and demotes the inherited one', () => {
    const input = forkOf(failed, [
      message({
        id: 'new-prompt',
        sortIndex: 3,
        turnOutcome: { kind: 'failed', settledAt: 200, error: 'New failure' }
      })
    ])
    expect(resolveCurrentTurnOutcomeItem(input)).toMatchObject({
      promptMessageId: 'new-prompt',
      outcome: { error: 'New failure' }
    })
    const ids = createWorkspaceConversationTimeline(input).map(({ id }) => id)
    expect(ids).toContain('turn-outcome-inherited-prompt')
    expect(ids).not.toContain('turn-outcome-new-prompt')
  })

  it('does not suppress the notice of a fork without a recorded head', () => {
    const input = { ...forkOf(failed), forkHeadMessageId: undefined }
    expect(resolveCurrentTurnOutcomeItem(input)?.promptMessageId).toBe('inherited-prompt')
  })

  it('keeps an inherited turn historical while a new prompt is being prepared', () => {
    const input = session({
      ...forkOf(failed, [message({ id: 'new-prompt', sortIndex: 3, createdAt: 200 })]),
      status: 'running',
      activeRun: { promptMessageId: 'new-prompt', startedAt: 210 },
      promptPreparation: {
        id: 'preparation-fork',
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'new-prompt',
        mode: 'new',
        preparedAt: 205,
        runStartedAt: 210,
        previousState: { status: 'idle' },
        expectedState: { status: 'running' }
      }
    })
    expect(resolveCurrentTurnOutcomeItem(input)).toBeUndefined()
  })
})

describe('branch turn boundary', () => {
  it('keeps the selected branch turn before follow-ups even with later inherited provenance', () => {
    const input = session({
      branchSource: { sessionId: 'source', headMessageId: 'branch-answer' },
      messages: [
        message({ id: 'branch-answer', role: 'agent', sortIndex: 1, completedAt: 200 }),
        message({
          id: 'followup',
          sortIndex: 2,
          usageOrigin: { sessionId: 'other', messageId: 'other' }
        })
      ]
    })
    expect(resolveForkBoundaryItemId(input, createWorkspaceConversationTimeline(input))).toBe(
      'turn-completion-branch-answer'
    )
  })
})

it.each(['missing-head', undefined])(
  'does not guess a branch boundary when its head is %s',
  (headMessageId) => {
    const input = session({
      branchSource: { sessionId: 'source', headMessageId },
      messages: [message({ usageOrigin: { sessionId: 'source', messageId: 'old' } })]
    })
    expect(
      resolveForkBoundaryItemId(input, createWorkspaceConversationTimeline(input))
    ).toBeUndefined()
  }
)

it('anchors a branch with a hidden head to its last visible ancestor', () => {
  const input = session({
    branchSource: { sessionId: 'source', headMessageId: 'hidden' },
    messages: [message({ id: 'visible', sortIndex: 1 }), message({ id: 'hidden', sortIndex: 2 })]
  })
  const timeline = createWorkspaceConversationTimeline(input).filter((item) => item.id !== 'hidden')
  expect(resolveForkBoundaryItemId(input, timeline)).toBe('visible')
})
