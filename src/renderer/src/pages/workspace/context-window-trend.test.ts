import { describe, expect, it } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import type { AcpContextWindowSample } from '../../../../shared/acp'
import {
  groupContextWindowCallsByTurn,
  selectContextWindowCallPoints,
  selectContextWindowTrendPoints,
  summarizeContextWindowCallPoints
} from './context-window-trend'

const sample = (
  id: string,
  used: number,
  timestamp: number,
  runtimeSegmentId: string
): AcpContextWindowSample => ({
  id,
  timestamp,
  runtimeSegmentId,
  termination: { kind: 'stop' as const, stopReason: 'end_turn' as const },
  contextWindow: { used, size: 128_000 },
  source: 'provider-response' as const
})

describe('context window trend selector', () => {
  it('selects exact calls from Agent messages and summarizes without summing context snapshots', () => {
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Calls',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Inspect calls',
          eventIds: [],
          status: 'complete',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'answer-1',
          role: 'agent',
          responseToMessageId: 'prompt-1',
          content: 'Done',
          eventIds: [],
          status: 'complete',
          turnUsage: {
            inputTokens: 30,
            cacheTokens: 6,
            outputTokens: 8,
            turnCount: 2
          },
          modelCallUsage: [
            {
              id: 'answer-1:model-call:0',
              index: 0,
              inputTokens: 10,
              cacheTokens: 2,
              outputTokens: 3,
              contextUsedTokens: 12,
              contextWindowSize: 100
            },
            {
              id: 'answer-1:model-call:1',
              index: 1,
              inputTokens: 20,
              cacheTokens: 4,
              outputTokens: 5,
              contextUsedTokens: 24,
              contextWindowSize: 100
            }
          ],
          createdAt: 2,
          updatedAt: 3,
          completedAt: 3
        }
      ],
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: 'root',
        activeFrameId: 'root',
        frames: [
          {
            id: 'root',
            originBindingState: 'root',
            kind: 'root',
            status: 'completed',
            activeBranchId: 'branch-1',
            createdAt: 1
          }
        ],
        branches: [
          {
            id: 'branch-1',
            agentFrameId: 'root',
            headMessageId: 'answer-1',
            createdAt: 1,
            updatedAt: 3
          }
        ],
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Inspect calls',
            eventIds: [],
            status: 'complete',
            agentFrameId: 'root',
            introducedOnBranchId: 'branch-1',
            revisionRootMessageId: 'prompt-1',
            runtimeSegmentId: 'runtime-1',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'answer-1',
            role: 'agent',
            content: 'Done',
            responseToMessageId: 'prompt-1',
            eventIds: [],
            status: 'complete',
            agentFrameId: 'root',
            introducedOnBranchId: 'branch-1',
            revisionRootMessageId: 'answer-1',
            runtimeSegmentId: 'runtime-1',
            createdAt: 2,
            updatedAt: 3
          }
        ],
        activities: [],
        activityGroups: [],
        runtimeSegments: [
          {
            id: 'runtime-1',
            agentFrameId: 'root',
            frameworkId: 'opencode',
            model: 'gpt-5',
            startedAt: 1
          }
        ]
      },
      createdAt: 1,
      updatedAt: 3
    } satisfies ChatSession

    const calls = selectContextWindowCallPoints(session)
    expect(calls).toMatchObject([
      { callNumber: 1, turnNumber: 1, prompt: 'Inspect calls', runtime: { model: 'gpt-5' } },
      { callNumber: 2, turnNumber: 1, prompt: 'Inspect calls', runtime: { model: 'gpt-5' } }
    ])
    expect(summarizeContextWindowCallPoints(calls)).toEqual({
      callCount: 2,
      inputTokens: 30,
      cacheTokens: 6,
      outputTokens: 8,
      peakContextUsedTokens: 24,
      contextWindowSize: 100
    })
    expect(groupContextWindowCallsByTurn(calls)).toMatchObject([
      { turnNumber: 1, messageNumber: 2, calls: [{ callNumber: 1 }, { callNumber: 2 }] }
    ])
  })

  it('groups consecutive calls into one band per turn and reports no peak without context data', () => {
    const agentMessage = (
      id: string,
      promptId: string,
      createdAt: number,
      calls: {
        id: string
        index: number
        inputTokens: number
        cacheTokens: number
        outputTokens: number
      }[]
    ): ChatSession['messages'][number] => ({
      id,
      role: 'agent' as const,
      responseToMessageId: promptId,
      content: 'Done',
      eventIds: [],
      status: 'complete' as const,
      turnUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3, turnCount: calls.length },
      modelCallUsage: calls,
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt
    })
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Bands',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'First',
          eventIds: [],
          status: 'complete',
          createdAt: 1,
          updatedAt: 1
        },
        agentMessage('answer-1', 'prompt-1', 2, [
          { id: 'call-1', index: 0, inputTokens: 5, cacheTokens: 1, outputTokens: 2 },
          { id: 'call-2', index: 1, inputTokens: 6, cacheTokens: 1, outputTokens: 2 }
        ]),
        {
          id: 'prompt-2',
          role: 'user',
          content: 'Second',
          eventIds: [],
          status: 'complete',
          createdAt: 3,
          updatedAt: 3
        },
        agentMessage('answer-2', 'prompt-2', 4, [
          { id: 'call-3', index: 0, inputTokens: 7, cacheTokens: 2, outputTokens: 1 }
        ])
      ],
      createdAt: 1,
      updatedAt: 4
    } satisfies ChatSession

    const calls = selectContextWindowCallPoints(session)
    expect(
      groupContextWindowCallsByTurn(calls).map((band) => ({
        turnNumber: band.turnNumber,
        callIds: band.calls.map((point) => point.call.id)
      }))
    ).toEqual([
      { turnNumber: 1, callIds: ['call-1', 'call-2'] },
      { turnNumber: 2, callIds: ['call-3'] }
    ])
    expect(summarizeContextWindowCallPoints(calls)).toEqual({
      callCount: 3,
      inputTokens: 18,
      cacheTokens: 4,
      outputTokens: 5
    })
  })

  it('reads only the active message projection while resolving historical runtime segments', () => {
    const activeSample = sample('active-run', 34_000, 200, 'runtime-codex')
    const inactiveSample = sample('inactive-run', 22_000, 100, 'runtime-claude')
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Trend',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'active-prompt',
          role: 'user',
          content: 'Active prompt',
          eventIds: [],
          status: 'complete',
          contextWindowSamples: [activeSample],
          createdAt: 1,
          updatedAt: 2
        },
        {
          id: 'active-answer',
          role: 'agent',
          responseToMessageId: 'active-prompt',
          content: 'Active answer',
          eventIds: [],
          status: 'complete',
          turnUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3, turnCount: 1 },
          modelCallUsage: [
            {
              id: 'active-call',
              index: 0,
              inputTokens: 10,
              cacheTokens: 2,
              outputTokens: 3
            }
          ],
          createdAt: 2,
          updatedAt: 3
        }
      ],
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: 'root',
        activeFrameId: 'root',
        frames: [
          {
            id: 'root',
            originBindingState: 'root',
            kind: 'root',
            status: 'completed',
            activeBranchId: 'active-branch',
            createdAt: 1
          }
        ],
        branches: [
          {
            id: 'active-branch',
            agentFrameId: 'root',
            headMessageId: 'active-prompt',
            createdAt: 1,
            updatedAt: 2
          },
          {
            id: 'inactive-branch',
            agentFrameId: 'root',
            headMessageId: 'inactive-prompt',
            createdAt: 1,
            updatedAt: 2
          }
        ],
        messages: [
          {
            id: 'active-prompt',
            role: 'user',
            content: 'Active prompt',
            eventIds: [],
            status: 'complete',
            contextWindowSamples: [activeSample],
            agentFrameId: 'root',
            introducedOnBranchId: 'active-branch',
            revisionRootMessageId: 'active-prompt',
            runtimeSegmentId: 'runtime-codex',
            createdAt: 1,
            updatedAt: 2
          },
          {
            id: 'inactive-prompt',
            role: 'user',
            content: 'Inactive prompt',
            eventIds: [],
            status: 'complete',
            contextWindowSamples: [inactiveSample],
            agentFrameId: 'root',
            introducedOnBranchId: 'inactive-branch',
            revisionRootMessageId: 'inactive-prompt',
            runtimeSegmentId: 'runtime-claude',
            createdAt: 1,
            updatedAt: 2
          },
          {
            id: 'active-answer',
            role: 'agent',
            content: 'Active answer',
            responseToMessageId: 'active-prompt',
            eventIds: [],
            status: 'complete',
            turnUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3, turnCount: 1 },
            modelCallUsage: [
              {
                id: 'active-call',
                index: 0,
                inputTokens: 10,
                cacheTokens: 2,
                outputTokens: 3
              }
            ],
            agentFrameId: 'root',
            introducedOnBranchId: 'active-branch',
            revisionRootMessageId: 'active-answer',
            runtimeSegmentId: 'runtime-codex',
            createdAt: 2,
            updatedAt: 3
          },
          {
            id: 'inactive-answer',
            role: 'agent',
            content: 'Inactive answer',
            responseToMessageId: 'inactive-prompt',
            eventIds: [],
            status: 'complete',
            turnUsage: { inputTokens: 20, cacheTokens: 4, outputTokens: 5, turnCount: 1 },
            modelCallUsage: [
              {
                id: 'inactive-call',
                index: 0,
                inputTokens: 20,
                cacheTokens: 4,
                outputTokens: 5
              }
            ],
            agentFrameId: 'root',
            introducedOnBranchId: 'inactive-branch',
            revisionRootMessageId: 'inactive-answer',
            runtimeSegmentId: 'runtime-claude',
            createdAt: 2,
            updatedAt: 3
          }
        ],
        activities: [],
        activityGroups: [],
        runtimeSegments: [
          {
            id: 'runtime-claude',
            agentFrameId: 'root',
            frameworkId: 'claude-code',
            backendId: 'anthropic',
            model: 'claude-sonnet-4-5',
            startedAt: 1
          },
          {
            id: 'runtime-codex',
            agentFrameId: 'root',
            frameworkId: 'codex',
            backendId: 'openai',
            model: 'gpt-5.6-codex',
            startedAt: 2
          }
        ]
      },
      createdAt: 1,
      updatedAt: 2
    } satisfies ChatSession

    expect(selectContextWindowTrendPoints(session)).toEqual([
      expect.objectContaining({
        runNumber: 1,
        messageNumber: 1,
        promptMessageId: 'active-prompt',
        sample: activeSample,
        agentName: 'Main Agent',
        runtime: expect.objectContaining({
          frameworkId: 'codex',
          backendId: 'openai',
          model: 'gpt-5.6-codex'
        })
      })
    ])
    expect(selectContextWindowCallPoints(session)).toMatchObject([
      { callNumber: 1, turnNumber: 1, messageId: 'active-answer', prompt: 'Active prompt' }
    ])
    expect(summarizeContextWindowCallPoints(selectContextWindowCallPoints(session))).toEqual({
      callCount: 1,
      inputTokens: 10,
      cacheTokens: 2,
      outputTokens: 3
    })
  })

  it('coalesces repeated completions for one visible message without hiding interruptions', () => {
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Trend',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Resume me',
          eventIds: [],
          status: 'complete',
          contextWindowSamples: [
            sample('ask-user-completed', 32_000, 150, 'runtime-1'),
            sample('message-completed', 34_000, 200, 'runtime-1'),
            {
              ...sample('cancelled', 31_000, 100, 'runtime-1'),
              termination: { kind: 'stop' as const, stopReason: 'cancelled' as const }
            }
          ],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      createdAt: 1,
      updatedAt: 2
    } satisfies ChatSession

    expect(selectContextWindowTrendPoints(session).map((point) => point.sample.id)).toEqual([
      'cancelled',
      'message-completed'
    ])
  })

  it('keeps an error and a later completion as separate terminal outcomes', () => {
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Trend',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Retry me',
          eventIds: [],
          status: 'complete',
          contextWindowSamples: [
            {
              ...sample('failed', 30_000, 100, 'runtime-1'),
              termination: { kind: 'error' as const }
            },
            sample('completed', 34_000, 200, 'runtime-1')
          ],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      createdAt: 1,
      updatedAt: 2
    } satisfies ChatSession

    expect(selectContextWindowTrendPoints(session).map((point) => point.sample.id)).toEqual([
      'failed',
      'completed'
    ])
  })

  it('marks only the last terminal outcome owned by a completed compaction prompt', () => {
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Trend',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Compact after this',
          eventIds: [],
          status: 'complete',
          contextWindowSamples: [
            {
              ...sample('cancelled', 31_000, 100, 'runtime-1'),
              termination: { kind: 'stop' as const, stopReason: 'cancelled' as const }
            },
            sample('completed', 34_000, 200, 'runtime-1')
          ],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      activities: [
        {
          id: 'context-compaction:1',
          kind: 'tool',
          title: 'Context compacted',
          promptMessageId: 'prompt-1',
          status: 'completed',
          eventIds: ['compact-start', 'compact-done'],
          sortIndex: 2,
          providerToolName: 'ContextCompaction',
          toolKind: 'other',
          createdAt: 210,
          updatedAt: 220
        }
      ],
      createdAt: 1,
      updatedAt: 2
    } satisfies ChatSession

    expect(
      selectContextWindowTrendPoints(session).map((point) => ({
        id: point.sample.id,
        compactedAfter: point.compactedAfter
      }))
    ).toEqual([
      { id: 'cancelled', compactedAfter: false },
      { id: 'completed', compactedAfter: true }
    ])
  })
})
