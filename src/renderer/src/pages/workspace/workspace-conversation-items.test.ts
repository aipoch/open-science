import { describe, expect, it } from 'vitest'

import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import { ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME } from '../../../../shared/acp'
import type { HandoffLifecycleEvent } from '../../../../shared/handoff-lifecycle'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import { normalizeSessionFile } from '../../../../shared/session-persistence'
import {
  createConversationItems,
  formatActivityTitle,
  isActivityActive
} from './workspace-conversation-items'

// Mock t function for tests
const t = (key: string, options?: Record<string, unknown>): string => {
  // Simple implementation that just handles interpolation
  if (options && 'name' in options) {
    return key.replace('{{name}}', String(options.name))
  }
  return key
}

const baseSession: ChatSession = {
  id: 'session-1',
  projectId: 'default',
  title: 'Session',
  cwd: '/workspace/project',
  status: 'running',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000
}

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: '',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

it('hides the durable Save as skill control message from the transcript', () => {
  const session: ChatSession = {
    ...baseSession,
    messages: [
      {
        id: 'visible-answer',
        role: 'agent',
        content: 'Completed analysis',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        completedAt: 1,
        updatedAt: 1
      },
      {
        id: 'hidden-control',
        role: 'user',
        content: 'Save as skill',
        status: 'complete',
        eventIds: [],
        turnIntent: 'save-as-skill',
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'visible-response',
        role: 'agent',
        content: 'This workflow can become a skill.',
        status: 'complete',
        eventIds: [],
        responseToMessageId: 'hidden-control',
        createdAt: 3,
        completedAt: 3,
        updatedAt: 3
      }
    ]
  }

  expect(createConversationItems(session).map(({ id }) => id)).toEqual([
    'visible-answer',
    'visible-response'
  ])
})

describe('workspace conversation items', () => {
  it('projects each active-branch direct-child upward message once in Main Agent timeline order', () => {
    const session: ChatSession = {
      ...baseSession,
      messages: [
        {
          id: 'root-prompt',
          role: 'user',
          content: 'Gather evidence',
          status: 'complete',
          eventIds: [],
          sortIndex: 1,
          createdAt: 100,
          updatedAt: 100
        },
        {
          id: 'root-answer',
          role: 'agent',
          content: 'Working on it.',
          status: 'complete',
          eventIds: [],
          responseToMessageId: 'root-prompt',
          sortIndex: 3,
          createdAt: 300,
          updatedAt: 300
        }
      ],
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: 'root-frame',
        activeFrameId: 'root-frame',
        frames: [
          {
            id: 'root-frame',
            originBindingState: 'root',
            kind: 'root',
            status: 'running',
            activeBranchId: 'root-active',
            createdAt: 100
          },
          {
            id: 'child-frame',
            parentFrameId: 'root-frame',
            originMessageId: 'root-prompt',
            originBindingState: 'validated',
            kind: 'delegate',
            delegateName: 'Evidence mapper',
            status: 'running',
            activeBranchId: 'child-branch',
            createdAt: 120
          },
          {
            id: 'nested-frame',
            parentFrameId: 'child-frame',
            originMessageId: 'child-prompt',
            originBindingState: 'validated',
            kind: 'delegate',
            delegateName: 'Nested worker',
            status: 'running',
            activeBranchId: 'nested-branch',
            createdAt: 130
          }
        ],
        branches: [
          {
            id: 'root-active',
            agentFrameId: 'root-frame',
            headMessageId: 'root-answer',
            createdAt: 100,
            updatedAt: 300
          }
        ],
        messages: [
          {
            id: 'root-prompt',
            role: 'user',
            content: 'Gather evidence',
            status: 'complete',
            eventIds: [],
            agentFrameId: 'root-frame',
            introducedOnBranchId: 'root-active',
            createdAt: 100,
            updatedAt: 100
          },
          {
            id: 'root-answer',
            role: 'agent',
            content: 'Working on it.',
            status: 'complete',
            eventIds: [],
            responseToMessageId: 'root-prompt',
            parentMessageId: 'root-prompt',
            agentFrameId: 'root-frame',
            introducedOnBranchId: 'root-active',
            createdAt: 300,
            updatedAt: 300
          }
        ],
        activities: [],
        activityGroups: [],
        runtimeSegments: []
      },
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [],
          messageCommands: [
            {
              messageId: 'upward-question',
              requestId: 'request-upward',
              sourcePrincipal: 'child',
              canonicalDigest: 'digest-upward',
              sourceFrameId: 'child-frame',
              targetFrameId: 'root-frame',
              rootOriginMessageId: 'root-prompt',
              callerRootMessageId: 'root-prompt',
              rootBranchId: 'root-active',
              rootBranchRevision: 'revision-1',
              direction: 'to_parent',
              disposition: 'message',
              text: 'Should I include the preprint evidence?',
              kind: 'question',
              laneSequence: 1,
              queuedAt: 200,
              receipt: { status: 'accepted', acceptedAt: 220, evidence: 'provider_prompt_accepted' }
            },
            {
              messageId: 'inactive-message',
              requestId: 'request-inactive',
              sourcePrincipal: 'child',
              canonicalDigest: 'digest-inactive',
              sourceFrameId: 'child-frame',
              targetFrameId: 'root-frame',
              rootOriginMessageId: 'root-prompt',
              callerRootMessageId: 'root-prompt',
              rootBranchId: 'root-inactive',
              rootBranchRevision: 'revision-2',
              direction: 'to_parent',
              disposition: 'message',
              text: 'Inactive',
              kind: 'info',
              laneSequence: 2,
              queuedAt: 210,
              receipt: { status: 'queued' }
            },
            {
              messageId: 'downward-message',
              requestId: 'request-downward',
              sourcePrincipal: 'root',
              canonicalDigest: 'digest-downward',
              sourceFrameId: 'root-frame',
              targetFrameId: 'child-frame',
              rootOriginMessageId: 'root-prompt',
              callerRootMessageId: 'root-prompt',
              rootBranchId: 'root-active',
              rootBranchRevision: 'revision-1',
              direction: 'to_child',
              disposition: 'message',
              text: 'Downward',
              kind: 'info',
              laneSequence: 1,
              queuedAt: 230,
              receipt: { status: 'queued' }
            },
            {
              messageId: 'nested-message',
              requestId: 'request-nested',
              sourcePrincipal: 'nested',
              canonicalDigest: 'digest-nested',
              sourceFrameId: 'nested-frame',
              targetFrameId: 'root-frame',
              rootOriginMessageId: 'root-prompt',
              callerRootMessageId: 'root-prompt',
              rootBranchId: 'root-active',
              rootBranchRevision: 'revision-1',
              direction: 'to_parent',
              disposition: 'message',
              text: 'Nested',
              kind: 'info',
              laneSequence: 1,
              queuedAt: 240,
              receipt: { status: 'queued' }
            }
          ]
        }
      }
    }

    expect(createConversationItems(session)).toEqual([
      expect.objectContaining({ id: 'root-prompt', type: 'message' }),
      expect.objectContaining({
        id: 'subagent-message-upward-question',
        type: 'subagent-message',
        createdAt: 200,
        message: expect.objectContaining({
          messageId: 'upward-question',
          sourceFrameId: 'child-frame',
          sourceName: 'Evidence mapper',
          kind: 'question',
          text: 'Should I include the preprint evidence?'
        })
      }),
      expect.objectContaining({ id: 'root-answer', type: 'message' })
    ])

    session.conversationGraph!.activeFrameId = 'child-frame'
    expect(createConversationItems(session).some(({ type }) => type === 'subagent-message')).toBe(
      false
    )
  })

  it('keeps one message identity when a valid durable receipt updates across restart hydration', () => {
    const rootPrompt = {
      id: 'restart-root-prompt',
      role: 'user' as const,
      content: 'Gather evidence',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 100,
      updatedAt: 100
    }
    const session: ChatSession = {
      ...baseSession,
      id: 'restart-session',
      messages: [rootPrompt]
    }
    const graph = createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages,
      frameworkId: 'codex',
      createdAt: 100,
      updatedAt: 100
    })
    const root = graph.frames.find(({ id }) => id === graph.rootFrameId)!
    graph.frames.push({
      id: 'restart-child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: rootPrompt.id,
      originBindingState: 'validated',
      kind: 'delegate',
      delegateName: 'Evidence mapper',
      status: 'running',
      activeBranchId: 'restart-child-branch',
      createdAt: 110
    })
    graph.branches.push({
      id: 'restart-child-branch',
      agentFrameId: 'restart-child-frame',
      headMessageId: 'restart-child-prompt',
      createdAt: 110,
      updatedAt: 110
    })
    graph.messages.push({
      id: 'restart-child-prompt',
      role: 'user',
      content: 'Map the evidence',
      status: 'complete',
      eventIds: [],
      agentFrameId: 'restart-child-frame',
      introducedOnBranchId: 'restart-child-branch',
      createdAt: 110,
      updatedAt: 110
    })
    session.conversationGraph = graph
    const queuedCommand = {
      messageId: 'restart-upward-message',
      requestId: 'restart-upward-request',
      sourcePrincipal: 'restart-child-frame',
      canonicalDigest: 'a'.repeat(64),
      sourceFrameId: 'restart-child-frame',
      sourceAttemptId: 'restart-child-attempt',
      targetFrameId: graph.rootFrameId,
      rootPromptMessageId: rootPrompt.id,
      rootOriginMessageId: rootPrompt.id,
      callerRootMessageId: rootPrompt.id,
      rootBranchId: root.activeBranchId,
      rootBranchRevision: `${root.activeBranchId}:100`,
      direction: 'to_parent' as const,
      disposition: 'message' as const,
      text: 'Should I include the preprint evidence?',
      kind: 'question' as const,
      laneSequence: 1,
      queuedAt: 120,
      receipt: { status: 'queued' as const }
    }
    session.runtimeContext = {
      version: 1,
      revision: 1,
      delegatedWork: { records: [], messageCommands: [queuedCommand] }
    }

    const beforeRestart = normalizeSessionFile(structuredClone(session))
    expect(beforeRestart?.runtimeContext?.delegatedWork?.messageCommands).toHaveLength(1)
    expect(createConversationItems(beforeRestart as ChatSession)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'subagent-message-restart-upward-message',
          message: expect.not.objectContaining({ receipt: expect.anything() })
        })
      ])
    )

    const afterRestart = normalizeSessionFile({
      ...structuredClone(beforeRestart!),
      runtimeContext: {
        ...beforeRestart!.runtimeContext!,
        revision: 2,
        delegatedWork: {
          records: [],
          messageCommands: [
            {
              ...queuedCommand,
              receipt: {
                status: 'accepted' as const,
                acceptedAt: 130,
                evidence: 'provider_prompt_accepted' as const
              }
            }
          ]
        }
      }
    })
    const hydratedItems = createConversationItems(afterRestart as ChatSession).filter(
      ({ type }) => type === 'subagent-message'
    )

    expect(afterRestart?.runtimeContext?.delegatedWork?.messageCommands).toHaveLength(1)
    expect(hydratedItems).toEqual([
      expect.objectContaining({
        id: 'subagent-message-restart-upward-message',
        message: expect.not.objectContaining({ receipt: expect.anything() })
      })
    ])
  })

  it('shows an OpenCode Skill name without exposing its content', () => {
    expect(
      formatActivityTitle(
        createActivity({ title: 'Loaded skill: mcp-pubmed', status: 'completed' }),
        undefined,
        t
      )
    ).toBe('Loaded skill: mcp-pubmed')
  })

  it('keeps the projected Codex Skill name when a load fails', () => {
    expect(
      formatActivityTitle(
        createActivity({ title: 'Loading skill: mcp-pubmed', status: 'failed' }),
        undefined,
        t
      )
    ).toBe('Skill failed: mcp-pubmed')
  })

  it('projects context compaction as a standalone status item with trusted lifecycle copy', () => {
    const activity = createActivity({
      id: 'context-compaction:1',
      providerToolName: ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME,
      status: 'in_progress',
      title: 'Compacting context'
    })
    const session: ChatSession = { ...baseSession, activities: [activity] }

    expect(formatActivityTitle(activity, undefined, t)).toBe('Compacting context')
    expect(
      formatActivityTitle(
        { ...activity, status: 'completed', title: 'Context compaction cancelled' },
        undefined,
        t
      )
    ).toBe('Context compaction cancelled')
    expect(createConversationItems(session)).toEqual([
      expect.objectContaining({
        id: 'compaction-activity-context-compaction:1',
        type: 'compaction-activity',
        activity
      })
    ])
  })

  it('orders messages and activities by stable runtime sort index when timestamps match', () => {
    const session: ChatSession = {
      ...baseSession,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Search this',
          status: 'complete',
          eventIds: [],
          sortIndex: 1,
          createdAt: 1710000000000,
          updatedAt: 1710000000000
        },
        {
          id: 'message-2',
          role: 'agent',
          content: 'Here are the results',
          status: 'streaming',
          eventIds: ['event-3'],
          sortIndex: 3,
          createdAt: 1710000000000,
          updatedAt: 1710000000000
        }
      ],
      activities: [
        createActivity({
          id: 'tool-web-1',
          title: '"open science repositories"',
          toolKind: 'search',
          sortIndex: 2
        })
      ]
    }

    expect(createConversationItems(session).map((item) => item.id)).toEqual([
      'message-1',
      'activity-tool-web-1',
      'message-2'
    ])
  })

  describe('session config-change markers', () => {
    const targetA = {
      frameworkId: 'claude-code' as const,
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'default' as const
    }
    const targetB = {
      frameworkId: 'claude-code' as const,
      providerId: 'provider-a',
      model: 'model-b',
      reasoningEffort: 'default' as const
    }

    const stampedUserMessage = (
      id: string,
      sortIndex: number,
      agentTarget?: ChatMessage['agentTarget']
    ): ChatMessage => ({
      id,
      role: 'user',
      content: `Turn ${id}`,
      status: 'complete',
      eventIds: [],
      sortIndex,
      createdAt: 1710000000000 + sortIndex,
      updatedAt: 1710000000000 + sortIndex,
      ...(agentTarget ? { agentTarget } : {})
    })

    const configChangeItems = (session: ChatSession): ReturnType<typeof createConversationItems> =>
      createConversationItems(session).filter((item) => item.type === 'session-config-change')

    it('marks a model change above the new user message', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [
          stampedUserMessage('message-1', 1, targetA),
          stampedUserMessage('message-2', 2, targetB)
        ]
      }

      const items = createConversationItems(session)
      const divider = items.find((item) => item.type === 'session-config-change')
      expect(divider).toEqual({
        id: 'session-config-change-message-2',
        type: 'session-config-change',
        createdAt: 1710000000002,
        sortIndex: 1.5,
        agentTarget: targetB
      })
      expect(items.map((item) => item.id)).toEqual([
        'message-1',
        'session-config-change-message-2',
        'message-2'
      ])
    })

    it('marks an effort-only change', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [
          stampedUserMessage('message-1', 1, targetA),
          stampedUserMessage('message-2', 2, { ...targetA, reasoningEffort: 'high' })
        ]
      }

      expect(configChangeItems(session)).toHaveLength(1)
    })

    it('marks a framework change', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [
          stampedUserMessage('message-1', 1, targetA),
          stampedUserMessage('message-2', 2, { ...targetA, frameworkId: 'codex' })
        ]
      }

      expect(configChangeItems(session)).toHaveLength(1)
    })

    it('marks a backend-only change', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [
          stampedUserMessage('message-1', 1, targetA),
          stampedUserMessage('message-2', 2, { ...targetA, backendId: 'codex-bridge' })
        ]
      }

      expect(configChangeItems(session)).toHaveLength(1)
    })

    it('stays quiet when the target is unchanged', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [
          stampedUserMessage('message-1', 1, targetA),
          stampedUserMessage('message-2', 2, targetA)
        ]
      }

      expect(configChangeItems(session)).toEqual([])
    })

    it('stays quiet on the first stamped message of a session', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [stampedUserMessage('message-1', 1, targetA)]
      }

      expect(configChangeItems(session)).toEqual([])
    })

    it('stays quiet when the previous turn predates snapshots', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [stampedUserMessage('message-1', 1), stampedUserMessage('message-2', 2, targetA)]
      }

      expect(configChangeItems(session)).toEqual([])
    })

    it('ignores unstamped gaps between stamped turns when comparing', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [
          stampedUserMessage('message-1', 1, targetA),
          stampedUserMessage('message-2', 2),
          stampedUserMessage('message-3', 3, targetB)
        ]
      }

      expect(configChangeItems(session).map((item) => item.id)).toEqual([
        'session-config-change-message-3'
      ])
    })

    it('stays quiet when picker churn nets out between sent turns', () => {
      // A → B → A in the picker records only the two applied sends, both with target A.
      const session: ChatSession = {
        ...baseSession,
        messages: [
          stampedUserMessage('message-1', 1, targetA),
          stampedUserMessage('message-2', 2, targetA)
        ]
      }

      expect(configChangeItems(session)).toEqual([])
    })

    it('marks a branched session first send whose config differs from the copied history', () => {
      const session: ChatSession = {
        ...baseSession,
        branchSource: { sessionId: 'source-session' },
        messages: [
          stampedUserMessage('copied-1', 1, targetA),
          stampedUserMessage('message-2', 2, targetB)
        ]
      }

      expect(configChangeItems(session).map((item) => item.id)).toEqual([
        'session-config-change-message-2'
      ])
    })

    it('ignores relayed side-chat messages when tracking the baseline', () => {
      const session: ChatSession = {
        ...baseSession,
        messages: [
          stampedUserMessage('message-1', 1, targetA),
          {
            ...stampedUserMessage('relay-1', 2, targetB),
            relayedFrom: { kind: 'side-chat', direction: 'to-main' }
          },
          stampedUserMessage('message-3', 3, targetA)
        ]
      }

      expect(configChangeItems(session)).toEqual([])
    })
  })

  it('projects every generate_plan status as a standalone item and hides step status updates', () => {
    const session: ChatSession = {
      ...baseSession,
      activities: [
        createActivity({
          id: 'plan-generate',
          providerToolName: 'mcp__open-science-plan__generate_plan',
          status: 'pending',
          sortIndex: 1
        }),
        createActivity({
          id: 'plan-status',
          providerToolName: 'mcp.open-science-plan.update_step_status',
          sortIndex: 2
        }),
        createActivity({
          id: 'plan-opencode',
          providerToolName: 'open_science_plan_generate_plan',
          status: 'in_progress',
          sortIndex: 3
        }),
        createActivity({
          id: 'completed-plan',
          title: 'generate_plan',
          status: 'completed',
          sortIndex: 4
        }),
        createActivity({
          id: 'failed-plan',
          providerToolName: 'generate_plan',
          status: 'failed',
          sortIndex: 5
        }),
        createActivity({
          id: 'failed-status',
          providerToolName: 'update_step_status',
          status: 'failed',
          sortIndex: 6
        })
      ]
    }

    expect(createConversationItems(session).map((item) => [item.id, item.type])).toEqual([
      ['plan-activity-plan-generate', 'plan-activity'],
      ['plan-activity-plan-opencode', 'plan-activity'],
      ['plan-activity-completed-plan', 'plan-activity'],
      ['plan-activity-failed-plan', 'plan-activity']
    ])
  })

  it('keeps a generate_plan revision at its chronological position between messages and tools', () => {
    const session: ChatSession = {
      ...baseSession,
      messages: [
        {
          id: 'feedback',
          role: 'user',
          content: 'Please revise step two',
          status: 'complete',
          eventIds: [],
          sortIndex: 2,
          createdAt: 1710000000000,
          updatedAt: 1710000000000
        }
      ],
      activities: [
        createActivity({ id: 'read', toolKind: 'read', sortIndex: 1 }),
        createActivity({
          id: 'revision',
          providerToolName: 'mcp.open_science_plan.generate_plan',
          status: 'in_progress',
          sortIndex: 3
        })
      ]
    }

    expect(createConversationItems(session).map((item) => item.id)).toEqual([
      'activity-read',
      'feedback',
      'plan-activity-revision'
    ])
  })

  it('anchors a handoff lifecycle row to the original user turn without inventing another user message', () => {
    const session: ChatSession = {
      ...baseSession,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Analyze the sample',
          status: 'complete',
          eventIds: [],
          sortIndex: 1,
          createdAt: 1_000,
          updatedAt: 1_000
        },
        {
          id: 'assistant-1',
          role: 'agent',
          content: 'I will inspect the input first.',
          status: 'complete',
          responseToMessageId: 'user-1',
          eventIds: [],
          sortIndex: 3,
          createdAt: 1_200,
          updatedAt: 1_200
        },
        {
          id: 'assistant-2',
          role: 'agent',
          content: 'Continuing with the approved specialist.',
          status: 'streaming',
          responseToMessageId: 'user-1',
          eventIds: [],
          sortIndex: 4,
          createdAt: 1_300,
          updatedAt: 1_300
        }
      ]
    }
    const handoff: HandoffLifecycleEvent = {
      id: 'handoff-1',
      sessionId: 'session-1',
      sequence: 2,
      observedAt: 1_100,
      phase: 'reconfiguring',
      target: { kind: 'specialist', name: 'Data analyst' },
      provenance: {
        originatingTurnId: 'turn-1',
        originatingUserMessageId: 'user-1',
        attachmentIds: ['upload-1'],
        artifactIds: ['artifact-1']
      }
    }

    const items = createConversationItems(session, [handoff])

    expect(items.map((item) => item.id)).toEqual([
      'user-1',
      'handoff:session-1:turn-1',
      'assistant-1',
      'assistant-2'
    ])
    expect(
      items.filter((item) => item.type === 'message' && item.message.role === 'user')
    ).toHaveLength(1)
    expect(items.find((item) => item.type === 'handoff')).toMatchObject({
      originatingUserMessageId: 'user-1',
      phase: 'reconfiguring',
      provenance: { attachmentIds: ['upload-1'], artifactIds: ['artifact-1'] }
    })
  })

  it('formats activities by tool identity without exposing title details', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-search-1',
          title: '"top news July 6 2026"',
          status: 'completed',
          toolKind: 'search'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: ToolSearch')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-search-2',
          status: 'pending',
          toolKind: 'search'
        }),
        undefined,
        t
      )
    ).toBe('Using tool: ToolSearch')
  })

  it('formats non-search tools by kind instead of title details', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-fetch-1',
          title: 'Fetch https://example.com',
          status: 'completed',
          toolKind: 'fetch'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: ToolFetch')
  })

  it('formats tools by provider identity when available without exposing title details', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-grep-1',
          title: 'grep "secret pattern" /workspace/private',
          status: 'completed',
          providerToolName: 'Grep',
          toolKind: 'search'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: Grep')
  })

  it('renders notebook MCP tools with a clean label instead of the raw provider name', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-notebook-1',
          status: 'completed',
          providerToolName: 'mcp__open-science-notebook__notebook_execute',
          toolKind: 'other'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: Notebook run')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-notebook-2',
          status: 'in_progress',
          providerToolName: 'mcp__open-science-notebook__notebook_restart',
          toolKind: 'other'
        }),
        undefined,
        t
      )
    ).toBe('Using tool: Notebook restart')
  })

  it.each([
    ['limit-reached', 'Execution limit reached: Notebook run'],
    ['cancelled', 'Cancelled: Notebook run'],
    ['interrupted', 'Interrupted: Notebook run'],
    ['failed', 'Tool failed: Notebook run'],
    ['completed', 'Used tool: Notebook run']
  ] as const)('formats the Notebook terminal phase %s', (phase, expected) => {
    expect(
      formatActivityTitle(
        createActivity({
          status: 'completed',
          providerToolName: 'mcp__open-science-notebook__notebook_execute'
        }),
        phase,
        t
      )
    ).toBe(expected)
  })

  it('formats an ordinary closed tool without implying rejection or execution cancellation', () => {
    expect(
      formatActivityTitle(
        createActivity({ status: 'in_progress', providerToolName: 'Bash' }),
        'closed',
        t
      )
    ).toBe('Request ended: Bash')
  })

  it('detects notebook tools whose server name was underscore-sanitized (Codex/gpt bridge)', () => {
    // The gpt/codex bridge rewrites the hyphenated server name to underscores; still a notebook cell.
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-notebook-underscore',
          status: 'completed',
          providerToolName: 'mcp__open_science_notebook__notebook_execute',
          toolKind: 'other'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: Notebook run')
  })

  it('detects a Codex notebook activity whose MCP identity is only in the title', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-codex-notebook',
          title: 'mcp.open-science-notebook.notebook_execute',
          status: 'completed',
          toolKind: 'execute'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: Notebook run')
  })

  it('falls back to readable tool kind names for unnamed tools', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-search-1',
          status: 'completed',
          toolKind: 'search'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: ToolSearch')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-fetch-1',
          status: 'completed',
          toolKind: 'fetch'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: ToolFetch')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-execute-1',
          status: 'in_progress',
          toolKind: 'execute'
        }),
        undefined,
        t
      )
    ).toBe('Using tool: ToolExecute')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-read-1',
          status: 'completed',
          toolKind: 'read'
        }),
        undefined,
        t
      )
    ).toBe('Used tool: ToolRead')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-unknown-1',
          status: 'completed',
          toolKind: undefined
        }),
        undefined,
        t
      )
    ).toBe('Used tool: tool')
  })

  it('preserves known wrapper tool titles when ACP omits a tool kind', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-wrapper-1',
          title: 'ToolSearch',
          status: 'completed',
          toolKind: undefined
        }),
        undefined,
        t
      )
    ).toBe('Used tool: ToolSearch')
  })

  it('marks failed and active activities by status', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-search-1',
          status: 'failed',
          toolKind: 'search'
        }),
        undefined,
        t
      )
    ).toBe('Tool failed: ToolSearch')

    expect(isActivityActive(createActivity({ status: 'pending' }))).toBe(true)
    expect(isActivityActive(createActivity({ status: 'in_progress' }))).toBe(true)
    expect(isActivityActive(createActivity({ status: 'completed' }))).toBe(false)
  })
})
