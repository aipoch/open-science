import { describe, expect, it } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import type { AcpContextWindowSample } from '../../../../shared/acp'
import { selectContextWindowTrendPoints } from './context-window-trend'

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
})
