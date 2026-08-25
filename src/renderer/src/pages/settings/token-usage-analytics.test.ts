import { describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import type {
  PersistedChatMessage,
  PersistedChatSession
} from '../../../../shared/session-persistence'
import type { Project } from '../../../../shared/projects'
import {
  buildTokenUsageAnalytics,
  buildTokenUsageAnalyticsFromProjection,
  selectTokenUsageSummary,
  tokenUsageMetricValue
} from './token-usage-analytics'

const localTime = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour).getTime()

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  createdAt: number,
  overrides: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role,
  content: id,
  status: 'complete',
  eventIds: [],
  createdAt,
  updatedAt: createdAt,
  ...overrides
})

const session = (
  id: string,
  createdAt: number,
  messages: PersistedChatMessage[],
  overrides: Partial<PersistedChatSession> = {}
): PersistedChatSession => ({
  id,
  projectId: 'project-1',
  title: id,
  cwd: '/workspace',
  status: 'idle',
  messages,
  createdAt,
  updatedAt: createdAt,
  ...overrides
})

const project = (id: string, createdAt: number): Project => ({
  id,
  name: id,
  description: '',
  isExample: false,
  createdAt,
  updatedAt: createdAt
})

describe('token usage analytics', () => {
  it('counts retained Projects supplied by the SQLite Usage projection', () => {
    const now = localTime(2026, 8, 15, 18)
    const yesterday = localTime(2026, 8, 14, 10)
    const analytics = buildTokenUsageAnalyticsFromProjection(
      {
        projectCreatedAt: [yesterday, now],
        sessionCreatedAt: [],
        artifactCreatedAt: [],
        runsAt: [],
        usageEvents: [],
        totalArtifacts: 0
      },
      now
    )

    expect(selectTokenUsageSummary(analytics, 'all')).toMatchObject({
      totalProjects: 2,
      newProjects: 2
    })
  })

  it('uses the conversation graph as authority and includes usage from inactive branches', () => {
    const now = localTime(2026, 8, 15)
    const firstRunAt = localTime(2026, 8, 14)
    const secondRunAt = localTime(2026, 8, 15, 9)
    const firstUser = message('user-1', 'user', firstRunAt)
    const firstAgent = message('agent-1', 'agent', firstRunAt, {
      completedAt: firstRunAt,
      turnUsage: { inputTokens: 10, cacheTokens: 3, outputTokens: 2 }
    })
    const graph = createLinearConversationGraph({
      sessionId: 'graph-session',
      messages: [firstUser, firstAgent],
      createdAt: firstRunAt,
      updatedAt: secondRunAt
    })
    const rootBranch = graph.branches[0]
    const runtimeSegmentId = graph.runtimeSegments[0].id
    graph.branches.push({
      id: 'inactive-branch',
      agentFrameId: graph.rootFrameId,
      headMessageId: 'agent-2',
      createdAt: secondRunAt,
      updatedAt: secondRunAt
    })
    graph.messages.push(
      {
        ...message('user-2', 'user', secondRunAt),
        agentFrameId: graph.rootFrameId,
        introducedOnBranchId: 'inactive-branch',
        parentMessageId: firstAgent.id,
        revisionRootMessageId: 'user-2',
        runtimeSegmentId
      },
      {
        ...message('agent-2', 'agent', secondRunAt, {
          completedAt: secondRunAt,
          turnUsage: { inputTokens: 20, cacheTokens: 7, outputTokens: 4 }
        }),
        agentFrameId: graph.rootFrameId,
        introducedOnBranchId: 'inactive-branch',
        parentMessageId: 'user-2',
        runtimeSegmentId
      }
    )
    rootBranch.headMessageId = firstAgent.id

    const analytics = buildTokenUsageAnalytics(
      [
        session(
          'graph-session',
          firstRunAt,
          [
            message('legacy-user', 'user', firstRunAt),
            message('legacy-agent', 'agent', firstRunAt, {
              turnUsage: { inputTokens: 1_000, cacheTokens: 1_000, outputTokens: 1_000 }
            })
          ],
          { conversationGraph: graph }
        )
      ],
      now
    )

    expect(selectTokenUsageSummary(analytics, 'all')).toMatchObject({
      inputTokens: 30,
      cacheTokens: 10,
      outputTokens: 6,
      totalTokens: 46,
      totalRuns: 2,
      newRuns: 2,
      reportedRuns: 2
    })
  })

  it('counts only top-level human prompts as runs while retaining all reported token cost', () => {
    const now = localTime(2026, 8, 15)
    const messages = [
      message('human', 'user', now),
      message('hidden', 'user', now, { turnIntent: 'save-as-skill' }),
      message('relay', 'user', now, { relayedFrom: { kind: 'side-chat', direction: 'to-main' } }),
      message('reviewer', 'user', now, {
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review-1'
        }
      }),
      message('delegate', 'user', now, {
        delegatedCallerSource: { rootMessageId: 'parent-prompt', toolInvocationId: 'tool-1' }
      }),
      message('agent', 'agent', now, {
        turnUsage: { inputTokens: 8, cacheTokens: 2, outputTokens: 5 }
      })
    ]

    const summary = selectTokenUsageSummary(
      buildTokenUsageAnalytics([session('session-1', now, messages)], now),
      'today'
    )

    expect(summary).toMatchObject({ totalRuns: 1, newRuns: 1, totalTokens: 15 })
  })

  it('applies local day, Monday week, 30-day, and all-time boundaries', () => {
    const now = localTime(2026, 8, 15, 18)
    const beforeWeek = localTime(2026, 8, 9)
    const thisWeek = localTime(2026, 8, 12)
    const today = localTime(2026, 8, 15, 8)
    const old = localTime(2026, 6, 1)

    const sessions = [
      session('old', old, [
        message('old-user', 'user', old),
        message('old-agent', 'agent', old, {
          turnUsage: { inputTokens: 1, cacheTokens: 0, outputTokens: 1 }
        })
      ]),
      session('recent', thisWeek, [
        message('before-week-user', 'user', beforeWeek),
        message('before-week-agent', 'agent', beforeWeek, {
          turnUsage: { inputTokens: 10, cacheTokens: 0, outputTokens: 5 }
        }),
        message('week-user', 'user', thisWeek),
        message('week-agent', 'agent', thisWeek, {
          turnUsage: { inputTokens: 20, cacheTokens: 10, outputTokens: 5 }
        }),
        message('today-user', 'user', today),
        message('today-agent', 'agent', today, {
          turnUsage: { inputTokens: 30, cacheTokens: 10, outputTokens: 10 }
        })
      ])
    ]
    const analytics = buildTokenUsageAnalytics(sessions, now)

    expect(selectTokenUsageSummary(analytics, 'today')).toMatchObject({
      totalTokens: 50,
      newConversations: 0,
      totalSessions: 2,
      totalRuns: 4,
      newRuns: 1,
      cacheShare: 0.25
    })
    expect(selectTokenUsageSummary(analytics, 'week')).toMatchObject({
      totalTokens: 85,
      newConversations: 1,
      newRuns: 2
    })
    expect(selectTokenUsageSummary(analytics, '30-days')).toMatchObject({
      totalTokens: 100,
      newConversations: 1,
      newRuns: 3
    })
    expect(selectTokenUsageSummary(analytics, 'all')).toMatchObject({
      totalTokens: 102,
      newConversations: 2,
      newRuns: 4
    })
  })

  it('returns a complete zero-filled 30-day series and includes project and artifact totals', () => {
    const now = localTime(2026, 8, 15, 18)
    const yesterday = localTime(2026, 8, 14, 10)
    const tomorrow = localTime(2026, 8, 16, 10)
    const analytics = buildTokenUsageAnalytics(
      [
        session(
          'session-1',
          yesterday,
          [
            message('user-reported', 'user', yesterday),
            message('agent-reported', 'agent', yesterday, {
              completedAt: yesterday,
              turnUsage: { inputTokens: 4, cacheTokens: 1, outputTokens: 2 }
            }),
            message('user-unavailable', 'user', now),
            message('agent-unavailable', 'agent', now, { turnUsageUnavailable: true })
          ],
          {
            artifacts: [
              {
                id: 'artifact-1',
                kind: 'managed-file',
                path: 'report.md',
                createdAt: yesterday
              },
              { id: 'artifact-2', kind: 'managed-file', path: 'chart.png' },
              {
                id: 'artifact-3',
                kind: 'managed-file',
                path: 'future.md',
                createdAt: tomorrow
              }
            ]
          }
        )
      ],
      now,
      [project('project-yesterday', yesterday), project('project-today', now)]
    )

    expect(analytics.last30Days).toHaveLength(30)
    expect(analytics.last30Days[0].dateKey).toBe('2026-07-17')
    expect(analytics.last30Days.at(-1)?.dateKey).toBe('2026-08-15')
    expect(analytics.last30Days.find((point) => point.dateKey === '2026-08-14')).toMatchObject({
      totalTokens: 7,
      newConversations: 1,
      newProjects: 1,
      newArtifacts: 1,
      runs: 1
    })
    expect(tokenUsageMetricValue(analytics.last30Days.at(-1)!, 'newProjects')).toBe(1)
    expect(tokenUsageMetricValue(analytics.last30Days.at(-1)!, 'newArtifacts')).toBe(0)
    expect(tokenUsageMetricValue(analytics.last30Days.at(-1)!, 'runs')).toBe(1)
    expect(selectTokenUsageSummary(analytics, '30-days')).toMatchObject({
      newRuns: 2,
      reportedRuns: 1,
      totalProjects: 2,
      newProjects: 2,
      totalArtifacts: 2,
      newArtifacts: 1
    })
    expect(selectTokenUsageSummary(analytics, 'all')).toMatchObject({
      totalArtifacts: 2,
      newArtifacts: 2
    })
  })

  it('falls back to the first associated message when an artifact has no persisted creation time', () => {
    const now = localTime(2026, 8, 15, 18)
    const yesterday = localTime(2026, 8, 14, 10)
    const analytics = buildTokenUsageAnalytics(
      [
        session(
          'session-1',
          yesterday,
          [
            message('agent-later', 'agent', now, {
              completedAt: now,
              artifactIds: ['artifact-1']
            }),
            message('agent-first', 'agent', yesterday, {
              completedAt: yesterday,
              artifactIds: ['artifact-1']
            })
          ],
          { artifacts: [{ id: 'artifact-1', kind: 'managed-file', path: 'report.md' }] }
        )
      ],
      now
    )

    expect(analytics.artifactCreatedAt).toEqual([yesterday])
    expect(selectTokenUsageSummary(analytics, 'today').newArtifacts).toBe(0)
    expect(selectTokenUsageSummary(analytics, '30-days').newArtifacts).toBe(1)
    expect(selectTokenUsageSummary(analytics, 'all').newArtifacts).toBe(1)
  })
})
