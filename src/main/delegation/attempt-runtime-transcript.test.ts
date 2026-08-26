import { describe, expect, it } from 'vitest'

import type { AcpAgentRuntimeUpdate } from '../../shared/acp'
import { projectAttemptRuntimeTranscript } from './attempt-runtime-transcript'

const scope = {
  projectId: 'project-1',
  sessionId: 'session-1',
  agentFrameId: 'frame-1',
  attemptId: 'attempt-1',
  runtimeSegmentId: 'runtime-1',
  promptMessageId: 'prompt-1'
} as const

const update = (event: AcpAgentRuntimeUpdate['event']): AcpAgentRuntimeUpdate => ({ scope, event })

describe('Attempt runtime transcript projection', () => {
  it('preserves message boundaries, tool history, groups, and terminal usage', () => {
    let messageId = 0
    const transcript = projectAttemptRuntimeTranscript({
      updates: [
        update({
          id: 'message-a:1',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          messageId: 'provider-message-a',
          role: 'assistant',
          text: 'First '
        }),
        update({
          id: 'message-a:2',
          timestamp: 11,
          kind: 'message',
          level: 'info',
          messageId: 'provider-message-a',
          role: 'assistant',
          text: 'finding.'
        }),
        update({
          id: 'group:start',
          timestamp: 12,
          kind: 'tool',
          level: 'info',
          toolCallId: 'group-1',
          providerToolName: 'mcp__open-science-activity__begin_activity_group',
          rawInput: { title: 'Inspect sources' },
          status: 'completed'
        }),
        update({
          id: 'tool:start',
          timestamp: 13,
          kind: 'tool',
          level: 'info',
          toolCallId: 'tool-1',
          title: 'Read source',
          status: 'in_progress',
          rawInput: { path: 'paper.pdf' }
        }),
        update({
          id: 'tool:done',
          timestamp: 14,
          kind: 'tool',
          level: 'info',
          toolCallId: 'tool-1',
          status: 'completed',
          rawOutput: { pages: 4 },
          terminalOutput: 'read 4 pages',
          terminalExitCode: 0
        }),
        update({
          id: 'message-b:1',
          timestamp: 15,
          kind: 'message',
          level: 'info',
          messageId: 'provider-message-b',
          role: 'assistant',
          text: 'Final answer.'
        })
      ],
      frameId: 'frame-1',
      promptMessageId: 'prompt-1',
      fallbackResponse: 'Final answer.',
      endedAt: 20,
      turnUsage: {
        inputTokens: 100,
        cacheTokens: 20,
        outputTokens: 30,
        turnCount: 1
      },
      modelCallUsage: [
        {
          id: 'message-2:model-call:0',
          index: 0,
          inputTokens: 100,
          cacheTokens: 20,
          outputTokens: 30,
          contextUsedTokens: 120,
          contextWindowSize: 200_000
        }
      ],
      createMessageId: () => `message-${++messageId}`
    })

    expect(transcript.messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        content: 'First finding.',
        eventIds: ['message-a:1', 'message-a:2'],
        completedAt: 11,
        updatedAt: 11
      }),
      expect.objectContaining({
        id: 'message-2',
        content: 'Final answer.',
        eventIds: ['message-b:1'],
        completedAt: 20,
        updatedAt: 20,
        turnUsage: {
          inputTokens: 100,
          cacheTokens: 20,
          outputTokens: 30,
          turnCount: 1
        },
        modelCallUsage: [
          {
            id: 'message-2:model-call:0',
            index: 0,
            inputTokens: 100,
            cacheTokens: 20,
            outputTokens: 30,
            contextUsedTokens: 120,
            contextWindowSize: 200_000
          }
        ]
      })
    ])
    expect(transcript.activities).toEqual([
      expect.objectContaining({
        id: 'agent-runtime:runtime-1:tool-1',
        activityGroupId: 'agent-runtime:runtime-1:group-1',
        promptMessageId: 'prompt-1',
        status: 'completed',
        eventIds: ['tool:start', 'tool:done'],
        rawInput: { path: 'paper.pdf' },
        rawOutput: { pages: 4 },
        terminalOutput: 'read 4 pages',
        terminalExitCode: 0
      })
    ])
    expect(transcript.activityGroups).toEqual([
      expect.objectContaining({
        id: 'agent-runtime:runtime-1:group-1',
        title: 'Inspect sources',
        promptMessageId: 'prompt-1',
        activityIds: ['agent-runtime:runtime-1:tool-1'],
        completedAt: 20
      })
    ])
    expect(transcript.terminalMessage?.id).toBe('message-2')
  })

  it('creates one usage-unavailable fallback message when no chunks were observed', () => {
    const transcript = projectAttemptRuntimeTranscript({
      updates: [],
      frameId: 'frame-1',
      promptMessageId: 'prompt-1',
      fallbackResponse: 'Fallback response',
      endedAt: 30,
      turnUsageUnavailable: true,
      createMessageId: () => 'fallback-message'
    })

    expect(transcript.messages).toEqual([
      expect.objectContaining({
        id: 'fallback-message',
        content: 'Fallback response',
        eventIds: [],
        turnUsageUnavailable: true
      })
    ])
  })

  it('derives graph-unique activity identities from each app-owned Runtime Segment', () => {
    const project = (
      runtimeSegmentId: string
    ): ReturnType<typeof projectAttemptRuntimeTranscript> =>
      projectAttemptRuntimeTranscript({
        updates: [
          {
            scope: { ...scope, runtimeSegmentId },
            event: {
              id: `${runtimeSegmentId}:group`,
              timestamp: 10,
              kind: 'tool',
              level: 'info',
              toolCallId: 'group-1',
              providerToolName: 'mcp__open-science-activity__begin_activity_group',
              rawInput: { title: 'Inspect evidence' },
              status: 'completed'
            }
          },
          {
            scope: { ...scope, runtimeSegmentId },
            event: {
              id: `${runtimeSegmentId}:tool`,
              timestamp: 11,
              kind: 'tool',
              level: 'info',
              toolCallId: 'tool-1',
              title: 'Read source',
              status: 'completed'
            }
          }
        ],
        frameId: 'frame-1',
        promptMessageId: 'prompt-1',
        fallbackResponse: 'done',
        endedAt: 12,
        createMessageId: () => `${runtimeSegmentId}:message`
      })

    const first = project('runtime-child-a')
    const second = project('runtime-child-b')

    expect(first.activities[0].id).not.toBe(second.activities[0].id)
    expect(first.activityGroups[0].id).not.toBe(second.activityGroups[0].id)
    expect(first.activities[0].activityGroupId).toBe(first.activityGroups[0].id)
    expect(second.activities[0].activityGroupId).toBe(second.activityGroups[0].id)
  })

  it('closes partial evidence as failed without inventing an error fallback Message', () => {
    const transcript = projectAttemptRuntimeTranscript({
      updates: [
        update({
          id: 'partial-message',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          messageId: 'partial-stream',
          role: 'assistant',
          text: 'Partial evidence'
        }),
        update({
          id: 'open-tool',
          timestamp: 11,
          kind: 'tool',
          level: 'info',
          toolCallId: 'tool-1',
          title: 'Read source',
          status: 'in_progress'
        })
      ],
      frameId: 'frame-1',
      promptMessageId: 'prompt-1',
      fallbackResponse: 'must not be used',
      endedAt: 20,
      terminalStatus: 'error',
      createMessageId: () => 'partial-message-id'
    })

    expect(transcript.messages).toEqual([
      expect.objectContaining({
        id: 'partial-message-id',
        content: 'Partial evidence',
        status: 'error',
        completedAt: 20,
        updatedAt: 20
      })
    ])
    expect(transcript.activities).toEqual([
      expect.objectContaining({ status: 'failed', updatedAt: 20 })
    ])
    expect(
      projectAttemptRuntimeTranscript({
        updates: [],
        frameId: 'frame-1',
        promptMessageId: 'prompt-1',
        fallbackResponse: 'must not be used',
        endedAt: 20,
        terminalStatus: 'cancelled',
        createMessageId: () => 'unexpected'
      }).messages
    ).toEqual([])
  })
})
