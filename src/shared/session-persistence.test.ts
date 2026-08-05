import { describe, expect, it } from 'vitest'

import { MAX_ACP_SESSION_IMAGE_BYTES } from './acp'

import {
  createSessionFile,
  sanitizeActivityGroup,
  normalizeSessionFile,
  sanitizeMessageImages,
  sanitizeToolActivity,
  type PersistedChatSession,
  type SessionPlanRuntimeContext
} from './session-persistence'
import { createLinearConversationGraph } from './conversation-graph'
import type { ActivePlanProjection } from './session-plan/contract'

const createSessionWithActivity = (activity: unknown): Record<string, unknown> => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  activities: [activity],
  createdAt: 1,
  updatedAt: 1
})

const getRestoredActivities = (session: unknown): PersistedChatSession['activities'] =>
  normalizeSessionFile(session)?.activities

const createRuntimePlan = (): SessionPlanRuntimeContext => ({
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  originatingPromptMessageId: 'prompt-plan-1',
  approval: 'pending',
  stepStatuses: {}
})

const createHistoricalPlan = (): ActivePlanProjection => ({
  artifactId: 'artifact-plan-history',
  artifactVersionId: 'version-plan-history',
  artifactChecksum: 'b'.repeat(64),
  originatingPromptMessageId: 'prompt-plan-history',
  revision: 3,
  approval: 'approved',
  lifecycle: 'completed',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Analyze the branched dataset',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Analysis report'],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: { 'Analyze data': { status: 'completed', updatedAt: 4 } },
  stepStates: { 'Analyze data': { status: 'completed' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 }
})

describe('branch Plan history persistence', () => {
  it('restores only branch-bound projections and recomputes their display state', () => {
    const valid = createHistoricalPlan()
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      planHistoryProjections: [
        { ...valid, originatingPromptMessageId: undefined },
        {
          ...valid,
          stepStates: { 'Analyze data': { status: 'not_started' } },
          counts: { phases: 99, delegations: 99, steps: 99, completed: 0, inProgress: 0 }
        }
      ]
    })

    expect(restored?.planHistoryProjections).toEqual([valid])
  })

  it('bounds aggregate history size while retaining the newest exact versions', () => {
    const history = Array.from({ length: 5 }, (_, index) => {
      const version = index + 1
      const plan = createHistoricalPlan()
      return {
        ...plan,
        artifactVersionId: `version-${version}`,
        originatingPromptMessageId: `prompt-${version}`,
        document: {
          ...plan.document,
          phases: [
            {
              ...plan.document.phases[0],
              delegations: [
                {
                  ...plan.document.phases[0].delegations[0],
                  steps: [
                    {
                      title: 'Analyze data',
                      description: `${version}${'x'.repeat(409_999)}`
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    })

    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      planHistoryProjections: history
    })

    expect(restored?.planHistoryProjections?.map((plan) => plan.artifactVersionId)).toEqual([
      'version-2',
      'version-3',
      'version-4',
      'version-5'
    ])
  })
})

describe('message part persistence', () => {
  it('preserves a linked-folder reference as root id plus relative path', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: '@study.csv',
          parts: [
            {
              type: 'artifact',
              id: 'linked-1',
              name: 'study.csv',
              source: 'linked-folder',
              rootId: 'root-1',
              relativePath: 'data/study.csv',
              path: '/must/not/be/persisted'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(restored?.messages[0].parts).toEqual([
      {
        type: 'artifact',
        id: 'linked-1',
        name: 'study.csv',
        source: 'linked-folder',
        rootId: 'root-1',
        relativePath: 'data/study.csv'
      }
    ])
  })
})

describe('message terminal time persistence', () => {
  it('backfills stable terminal timestamps for legacy agent messages', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'complete-message',
          role: 'agent',
          content: 'Done',
          status: 'complete',
          eventIds: [],
          createdAt: 10,
          updatedAt: 20
        },
        {
          id: 'failed-message',
          role: 'agent',
          content: 'Partial',
          status: 'error',
          eventIds: [],
          createdAt: 30,
          updatedAt: 40
        }
      ]
    })

    expect(restored?.messages).toEqual([
      expect.objectContaining({ id: 'complete-message', completedAt: 20 }),
      expect.objectContaining({ id: 'failed-message', failedAt: 40 })
    ])
  })

  it('preserves response linkage and explicit terminal timestamps when updatedAt changes later', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'prompt-message',
          role: 'user',
          content: 'Run the analysis',
          status: 'complete',
          eventIds: [],
          createdAt: 10,
          updatedAt: 10
        },
        {
          id: 'complete-message',
          role: 'agent',
          content: 'Done',
          status: 'complete',
          eventIds: [],
          responseToMessageId: 'prompt-message',
          createdAt: 11,
          completedAt: 20,
          updatedAt: 99
        },
        {
          id: 'failed-message',
          role: 'agent',
          content: 'Partial result',
          status: 'error',
          eventIds: [],
          responseToMessageId: 'prompt-message',
          createdAt: 12,
          failedAt: 30,
          updatedAt: 100
        }
      ]
    })

    expect(restored?.messages[1]).toMatchObject({
      responseToMessageId: 'prompt-message',
      completedAt: 20,
      updatedAt: 99
    })
    expect(restored?.messages[2]).toMatchObject({
      responseToMessageId: 'prompt-message',
      failedAt: 30,
      updatedAt: 100
    })
  })
})

describe('upload message persistence', () => {
  it('keeps immutable Version identity while removing absolute legacy paths', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Uploads',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Analyze this',
          uploads: [
            {
              id: 'upload-1',
              versionId: 'upload-version-1',
              versionNumber: 1,
              createdAt: '2026-07-27T12:00:00.000Z',
              sessionId: 'session-1',
              name: 'input.csv',
              originalName: 'input.csv',
              path: '/Users/private/input.csv',
              size: 12,
              checksum: 'a'.repeat(64)
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })

    expect(restored?.messages[0].uploads).toEqual([
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        createdAt: '2026-07-27T12:00:00.000Z',
        sessionId: 'session-1',
        name: 'input.csv',
        originalName: 'input.csv',
        size: 12,
        sha256: 'a'.repeat(64)
      }
    ])
    expect(JSON.stringify(restored)).not.toContain('/Users/private/input.csv')
  })
})

describe('message image persistence', () => {
  it('keeps only bounded raster images with recomputed byte metadata', () => {
    const images = sanitizeMessageImages([
      { id: 'image-1', mimeType: 'image/png', data: 'AQID', byteLength: 999 },
      { id: 'image-svg', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
      { id: 'image-bad', mimeType: 'image/jpeg', data: 'not base64!' }
    ])

    expect(images).toEqual([{ id: 'image-1', mimeType: 'image/png', data: 'AQID', byteLength: 3 }])
  })

  it('caps the number of persisted images in one message', () => {
    const images = sanitizeMessageImages(
      Array.from({ length: 6 }, (_, index) => ({
        id: `image-${index}`,
        mimeType: 'image/webp',
        data: 'AQID'
      }))
    )

    expect(images).toHaveLength(4)
    expect(images?.map((image) => image.id)).toEqual(['image-0', 'image-1', 'image-2', 'image-3'])
  })

  it('round-trips valid message images and drops invalid persisted data', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Images',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: '',
          status: 'complete',
          eventIds: ['event-1'],
          images: [
            { id: 'event-1', mimeType: 'image/png', data: 'AQID' },
            { id: 'event-2', mimeType: 'text/html', data: 'AQID' }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })

    expect(restored?.messages[0].images).toEqual([
      { id: 'event-1', mimeType: 'image/png', data: 'AQID', byteLength: 3 }
    ])
  })

  it('applies the aggregate session image budget while restoring legacy files', () => {
    const data = 'A'.repeat(4 * 1024 * 1024)
    const bytesPerImage = (data.length * 3) / 4
    const messageCount = MAX_ACP_SESSION_IMAGE_BYTES / bytesPerImage + 1
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Images',
      cwd: '/workspace',
      status: 'idle',
      messages: Array.from({ length: messageCount }, (_, index) => ({
        id: `message-${index}`,
        role: 'agent',
        content: '',
        images: [{ id: `image-${index}`, mimeType: 'image/png', data }],
        createdAt: index,
        updatedAt: index
      })),
      createdAt: 1,
      updatedAt: 1
    })

    const restoredImages = restored?.messages.flatMap((message) => message.images ?? []) ?? []
    expect(restoredImages).toHaveLength(MAX_ACP_SESSION_IMAGE_BYTES / bytesPerImage)
    expect(restoredImages.reduce((total, image) => total + image.byteLength, 0)).toBe(
      MAX_ACP_SESSION_IMAGE_BYTES
    )
  })

  it('sanitizes images that exist only on an inactive conversation branch before writing', () => {
    const activeMessage = {
      id: 'active-message',
      role: 'user' as const,
      content: 'Active prompt',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [activeMessage],
      createdAt: 1,
      updatedAt: 2
    })
    const inactiveBranchId = 'message-branch-inactive'
    const inactiveMessageId = 'inactive-message'
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-a',
      title: 'Images',
      cwd: '/workspace',
      status: 'idle',
      messages: [activeMessage],
      conversationGraph: {
        ...graph,
        branches: [
          ...graph.branches,
          {
            id: inactiveBranchId,
            agentFrameId: graph.rootFrameId,
            parentBranchId: graph.branches[0].id,
            headMessageId: inactiveMessageId,
            createdAt: 2,
            updatedAt: 2
          }
        ],
        messages: [
          ...graph.messages,
          {
            id: inactiveMessageId,
            role: 'agent',
            content: 'Inactive reply',
            status: 'complete',
            eventIds: [],
            images: Array.from({ length: 6 }, (_, index) => ({
              id: `inactive-image-${index}`,
              mimeType: 'image/png' as const,
              data: 'AQID',
              byteLength: 999
            })),
            agentFrameId: graph.rootFrameId,
            introducedOnBranchId: inactiveBranchId,
            createdAt: 2,
            updatedAt: 2
          }
        ]
      },
      createdAt: 1,
      updatedAt: 2
    }

    const persisted = createSessionFile(session).session
    const inactiveImages = persisted.conversationGraph?.messages.find(
      (message) => message.id === inactiveMessageId
    )?.images

    expect(inactiveImages).toHaveLength(4)
    expect(inactiveImages?.every((image) => image.byteLength === 3)).toBe(true)
  })
})

describe('turn token usage persistence', () => {
  it('round-trips valid totals and drops invalid usage fields', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Usage',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-valid',
          role: 'agent',
          content: 'Done',
          status: 'complete',
          eventIds: [],
          turnUsage: {
            inputTokens: 12_345,
            cacheTokens: 678,
            cachedReadTokens: 500,
            cachedWriteTokens: 178,
            outputTokens: 90,
            turnCount: 3
          },
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'message-invalid',
          role: 'agent',
          content: 'Also done',
          status: 'complete',
          eventIds: [],
          turnUsage: { inputTokens: -1, cacheTokens: 2, outputTokens: 3 },
          turnUsageUnavailable: true,
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'message-user',
          role: 'user',
          content: 'Prompt',
          status: 'complete',
          eventIds: [],
          turnUsageUnavailable: true,
          createdAt: 3,
          updatedAt: 3
        }
      ],
      createdAt: 1,
      updatedAt: 2
    })

    expect(restored?.messages[0].turnUsage).toEqual({
      inputTokens: 12_345,
      cacheTokens: 678,
      cachedReadTokens: 500,
      cachedWriteTokens: 178,
      outputTokens: 90,
      turnCount: 3
    })
    expect(restored?.messages[1].turnUsage).toBeUndefined()
    expect(restored?.messages[1].turnUsageUnavailable).toBe(true)
    expect(restored?.messages[2].turnUsageUnavailable).toBeUndefined()
  })
})

describe('context usage persistence', () => {
  it('round-trips a valid snapshot and drops malformed usage', () => {
    const contextUsage = {
      used: 29_500,
      agentUsed: 29_500,
      size: 168_000,
      breakdown: {
        source: 'estimated',
        tokenizer: 'o200k_base',
        model: 'gpt-5.6-sol',
        estimatedTokens: 29_405,
        difference: 95,
        status: 'reconciled',
        categories: [
          { key: 'system', tokens: 7_200, estimated: true },
          { key: 'other', tokens: 95, estimated: false }
        ]
      }
    }
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      contextUsage
    })
    const malformed = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      contextUsage: { used: -1, size: 168_000 }
    })
    const unsafeBreakdown = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      contextUsage: {
        used: 100,
        breakdown: {
          source: 'estimated',
          estimatedTokens: 100,
          difference: 0,
          status: 'reconciled',
          categories: [{ key: 'unknown', tokens: 100, estimated: true }]
        }
      }
    })

    expect(restored?.contextUsage).toEqual(contextUsage)
    expect(malformed?.contextUsage).toBeUndefined()
    expect(unsafeBreakdown?.contextUsage).toEqual({ used: 100 })
  })
})

describe('sanitizeToolActivity', () => {
  it('keeps identity fields and known text/diff content', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-1',
      kind: 'tool',
      title: 'Edit app.ts',
      activityGroupId: 'group-1',
      promptMessageId: 'prompt-1',
      status: 'completed',
      sortIndex: 3,
      eventIds: ['event-1'],
      providerToolName: 'Edit',
      toolKind: 'edit',
      toolLocations: [{ path: '/repo/app.ts', line: 12 }],
      toolContent: [
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'diff', path: '/repo/app.ts', oldText: 'a', newText: 'b' },
        { type: 'terminal', terminalId: 'term-1' }
      ],
      createdAt: 5,
      updatedAt: 6
    })

    expect(activity).toMatchObject({
      id: 'tool-1',
      kind: 'tool',
      title: 'Edit app.ts',
      activityGroupId: 'group-1',
      promptMessageId: 'prompt-1',
      status: 'completed',
      providerToolName: 'Edit',
      toolKind: 'edit',
      toolLocations: [{ path: '/repo/app.ts', line: 12 }]
    })
    // Terminal references carry no payload and are dropped; text/diff entries survive.
    expect(activity?.toolContent).toEqual([
      { type: 'content', content: { type: 'text', text: 'ok' } },
      { type: 'diff', path: '/repo/app.ts', oldText: 'a', newText: 'b' }
    ])
  })

  it('truncates oversized terminal output', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-1',
      status: 'completed',
      terminalOutput: 'x'.repeat(40_000)
    })

    expect(activity?.terminalOutput?.length).toBeLessThan(40_000)
    expect(activity?.terminalOutput?.endsWith('…')).toBe(true)
  })

  it('drops oversized raw payloads while keeping small ones', () => {
    const big = sanitizeToolActivity({
      id: 'tool-1',
      status: 'completed',
      rawInput: { filename: 'big.png', content: 'A'.repeat(50_000) }
    })
    const small = sanitizeToolActivity({
      id: 'tool-2',
      status: 'completed',
      rawInput: { command: 'ls -la' }
    })

    expect(big?.rawInput).toBeUndefined()
    expect(small?.rawInput).toEqual({ command: 'ls -la' })
  })

  it('rejects entries without an id', () => {
    expect(sanitizeToolActivity({ status: 'completed' })).toBeUndefined()
  })
})

describe('sanitizeActivityGroup', () => {
  it('keeps a valid group declaration bounded and structured', () => {
    expect(
      sanitizeActivityGroup({
        id: 'group-1',
        title: 'Inspect the implementation.',
        sortIndex: 4,
        activityIds: ['tool-1'],
        createdAt: 5,
        updatedAt: 6
      })
    ).toEqual({
      id: 'group-1',
      title: 'Inspect the implementation',
      sortIndex: 4,
      activityIds: ['tool-1'],
      createdAt: 5,
      updatedAt: 6
    })
  })
})

describe('normalizeSessionFile with activities', () => {
  it('round-trips a main-owned runtime context and preserves plan approval waiting across restart', () => {
    const persisted = createSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      status: 'waiting-plan-approval',
      runtimeContext: {
        version: 1,
        revision: 3,
        plan: createRuntimePlan()
      }
    })

    const restored = normalizeSessionFile(persisted)

    expect(restored).toMatchObject({
      status: 'waiting-plan-approval',
      runtimeContext: {
        version: 1,
        revision: 3,
        plan: createRuntimePlan()
      }
    })
    expect(restored?.error).toBeUndefined()
  })

  it('does not restore the expired interaction identity for a pending Plan', () => {
    const restored = normalizeSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      status: 'waiting-plan-approval',
      activeRun: { promptMessageId: 'expired-prompt', startedAt: 10 },
      runtimeContext: {
        version: 1,
        revision: 3,
        plan: createRuntimePlan()
      }
    })

    expect(restored?.status).toBe('waiting-plan-approval')
    expect(restored?.activeRun).toBeUndefined()
    expect(restored?.error).toBeUndefined()
  })

  it('restores an approved incomplete Plan passively instead of as a generic Session error', () => {
    const plan = { ...createRuntimePlan(), approval: 'approved' as const }
    const restored = normalizeSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      status: 'running',
      activeRun: { promptMessageId: 'prompt-1', startedAt: 10 },
      runtimeContext: { version: 1, revision: 4, plan }
    })

    expect(restored).toMatchObject({
      status: 'idle',
      runtimeContext: { version: 1, revision: 4, plan }
    })
    expect(restored?.activeRun).toBeUndefined()
    expect(restored?.error).toBeUndefined()
  })

  it('drops unknown or damaged runtime context without losing the conversation', () => {
    const unknown = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      runtimeContext: { version: 1, revision: 8, alienAuthority: { active: true } }
    })
    const damaged = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      title: 'Conversation survives',
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: -1, plan: { approval: 'approved' } }
    })
    const malformedPlan = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: 2, plan: null }
    })

    expect(unknown).toMatchObject({ id: 'session-1', messages: [] })
    expect(unknown?.runtimeContext).toBeUndefined()
    expect(damaged).toMatchObject({
      title: 'Conversation survives',
      status: 'idle',
      messages: []
    })
    expect(damaged?.runtimeContext).toBeUndefined()
    expect(malformedPlan).toMatchObject({ status: 'idle', messages: [] })
    expect(malformedPlan?.runtimeContext).toBeUndefined()
  })

  it('restores a persisted session with its activities intact', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'ls',
        status: 'completed',
        sortIndex: 1,
        eventIds: [],
        providerToolName: 'Bash',
        toolKind: 'execute',
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities).toEqual([
      expect.objectContaining({ id: 'activity-1', providerToolName: 'Bash', status: 'completed' })
    ])
  })

  it('restores open activities as failed', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'downloading',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities?.[0]?.status).toBe('failed')
  })

  it('restores open conversation graph activities as failed', () => {
    const persisted = createSessionFile({
      ...(createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'downloading',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }) as PersistedChatSession),
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Download it',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const restored = normalizeSessionFile(persisted)

    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('builds a legacy conversation graph from normalized interrupted messages', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Interrupted session',
      cwd: '/workspace',
      status: 'running',
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: 'Partial response',
          status: 'streaming',
          createdAt: 1,
          updatedAt: 7
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })

    expect(restored?.messages[0]?.status).toBe('error')
    expect(restored?.messages[0]?.failedAt).toBe(7)
    expect(restored?.conversationGraph?.messages[0]?.status).toBe('error')
    expect(restored?.conversationGraph?.messages[0]?.failedAt).toBe(7)
  })

  it('loads sessions that predate persisted activities', () => {
    const session = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Legacy',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })

    expect(session?.activities).toBeUndefined()
    expect(session?.permissionProfile).toBe('ask')
  })

  it('preserves a valid files revision and ignores malformed revisions', () => {
    const current = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      filesRevision: 7
    })
    const malformed = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      filesRevision: -1
    })

    expect(current?.filesRevision).toBe(7)
    expect(malformed?.filesRevision).toBeUndefined()
  })

  it('round-trips the agent backend identity and run model used for diagnostics', () => {
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:codex-isolated',
      agentModel: 'gpt-5.6-sol'
    })

    expect(session?.agentFrameworkId).toBe('codex')
    expect(session?.agentBackendId).toBe('codex:codex-isolated')
    expect(session?.agentModel).toBe('gpt-5.6-sol')
  })

  it('keeps known approval profiles and safely defaults unknown values', () => {
    const full = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      permissionProfile: 'full'
    })
    const unknown = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      permissionProfile: 'untrusted-profile'
    })

    expect(full?.permissionProfile).toBe('full')
    expect(unknown?.permissionProfile).toBe('ask')
  })

  it('round-trips the auto-review toggle and defaults older sessions to disabled', () => {
    const disabled = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: false
    })
    const enabled = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: true
    })
    // A session file written before the reviewer feature has no field at all.
    const legacy = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined
    })
    // A corrupt non-boolean value is treated as the safe default (disabled), not preserved.
    const corrupt = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: 'nope'
    })

    expect(disabled?.autoReviewEnabled).toBe(false)
    expect(enabled?.autoReviewEnabled).toBe(true)
    expect(legacy?.autoReviewEnabled).toBe(false)
    expect(corrupt?.autoReviewEnabled).toBe(false)
  })

  it('round-trips enabledComputeHosts and filters out invalid values', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined }

    // Valid ssh: prefixed provider ids survive the round-trip.
    const withHosts = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:cluster-1', 'ssh:gpu-box']
    })
    // Missing field (older sessions written before issue 06) → absent in output.
    const legacy = normalizeSessionFile({ ...base })
    // Non-ssh: strings are filtered out; only valid provider ids survive.
    const mixedValid = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:valid', 'not-ssh', '', 42]
    })
    // All invalid → field is absent (not an empty array).
    const allInvalid = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['no-prefix', 123]
    })

    expect(withHosts?.enabledComputeHosts).toEqual(['ssh:cluster-1', 'ssh:gpu-box'])
    expect(legacy?.enabledComputeHosts).toBeUndefined()
    expect(mixedValid?.enabledComputeHosts).toEqual(['ssh:valid'])
    expect(allInvalid?.enabledComputeHosts).toBeUndefined()
  })

  it('persists errorReportable only when a model-provider error marked it false', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined, status: 'error' }

    // A provider error tagged non-reportable at the ACP layer round-trips as false so the reloaded
    // session keeps the report button hidden.
    const providerFailure = normalizeSessionFile({
      ...base,
      error: 'Invalid API key',
      errorReportable: false
    })
    // A reportable failure does not persist the field (default is reportable — no need to store true).
    const reportableFailure = normalizeSessionFile({
      ...base,
      error: 'Agent session could not be created.',
      errorReportable: true
    })
    // An older session file, written before the flag existed, has no field and defaults to reportable.
    const legacy = normalizeSessionFile({ ...base, error: 'Some old failure' })
    // The flag is meaningless without an error and is dropped.
    const noError = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      errorReportable: false
    })

    expect(providerFailure?.errorReportable).toBe(false)
    expect(reportableFailure?.errorReportable).toBeUndefined()
    expect(legacy?.errorReportable).toBeUndefined()
    expect(noError?.errorReportable).toBeUndefined()
  })
})
