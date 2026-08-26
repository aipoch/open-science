import { describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { HostFramesService, type HostFramesRepository } from './host-frames-service'

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  createdAt: number
): PersistedChatMessage => ({
  id,
  role,
  content: `${role} ${id}`,
  status: 'complete',
  eventIds: [],
  createdAt,
  updatedAt: createdAt
})

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => {
  const id = overrides.id ?? 'session-1'
  const messages = overrides.messages ?? [message('message-1', 'user', 100)]
  const base: PersistedChatSession = {
    id,
    projectId: 'project-a',
    title: 'Literature review',
    cwd: '/private/workspace',
    status: 'idle',
    messages,
    conversationGraph: createLinearConversationGraph({
      sessionId: id,
      messages,
      frameworkId: 'claude-code',
      createdAt: 100,
      updatedAt: 200
    }),
    createdAt: 100,
    updatedAt: 200
  }
  return { ...base, ...overrides }
}

const context = { projectId: 'project-a', sessionId: 'calling-session' }

const renameRootFrame = (target: PersistedChatSession, frameId: string): void => {
  const graph = target.conversationGraph!
  graph.rootFrameId = frameId
  graph.activeFrameId = frameId
  graph.frames[0].id = frameId
  for (const branch of graph.branches) branch.agentFrameId = frameId
  for (const item of graph.messages) item.agentFrameId = frameId
  for (const segment of graph.runtimeSegments) segment.agentFrameId = frameId
}

describe('HostFramesService', () => {
  it('lists the current Project root Frame through the stable metadata projection', async () => {
    const readProject = vi.fn(async () => ({ sessions: [session()], isComplete: true }))
    const repository: HostFramesRepository = {
      readProject,
      readSession: vi.fn()
    }
    const service = new HostFramesService(repository)

    await expect(service.list({}, context)).resolves.toEqual({
      project_id: 'project-a',
      total_count: 1,
      frames: [
        {
          frame_id: 'root-frame-session-1',
          session_id: 'session-1',
          session_title: 'Literature review',
          kind: 'root',
          recorded_frame_status: 'completed',
          session_status: 'idle',
          created_at: new Date(100).toISOString(),
          completed_at: new Date(200).toISOString(),
          session_updated_at: new Date(200).toISOString(),
          message_count: 1,
          child_count: 0
        }
      ]
    })
    expect(readProject).toHaveBeenCalledWith('project-a')
  })

  it('excludes archived Sessions by default and orders eligible roots newest-first', async () => {
    const older = session({ id: 'older', title: 'Older', createdAt: 100, updatedAt: 200 })
    const newer = session({ id: 'newer', title: 'Newer', createdAt: 300, updatedAt: 400 })
    const archived = session({
      id: 'archived',
      title: 'Archived',
      archivedAt: 500,
      createdAt: 500,
      updatedAt: 600
    })
    older.conversationGraph!.frames[0].createdAt = 100
    newer.conversationGraph!.frames[0].createdAt = 300
    archived.conversationGraph!.frames[0].createdAt = 500
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [older, archived, newer], isComplete: true })),
      readSession: vi.fn()
    })

    const result = (await service.list({}, context)) as { frames: Array<{ frame_id: string }> }

    expect(result.frames.map((frame) => frame.frame_id)).toEqual([
      'root-frame-newer',
      'root-frame-older'
    ])
    await expect(service.list({ archived: 'only' }, context)).resolves.toMatchObject({
      total_count: 1,
      frames: [expect.objectContaining({ frame_id: 'root-frame-archived' })]
    })
    await expect(service.list({ archived: 'include' }, context)).resolves.toMatchObject({
      total_count: 3
    })
  })

  it('breaks equal-timestamp catalog ties with locale-independent identity ordering', async () => {
    const lower = session({ id: 'session-a' })
    const upper = session({ id: 'session-Z' })
    lower.conversationGraph!.frames[0].createdAt = 100
    upper.conversationGraph!.frames[0].createdAt = 100
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [lower, upper], isComplete: true })),
      readSession: vi.fn()
    })

    const result = (await service.list({}, context)) as { frames: Array<{ frame_id: string }> }

    expect(result.frames.map((frame) => frame.frame_id)).toEqual([
      'root-frame-session-Z',
      'root-frame-session-a'
    ])
  })

  it('narrows to one Session and filters Frame metadata without searching message bodies', async () => {
    const target = session({ title: 'Clinical genomics' })
    const graph = target.conversationGraph!
    graph.frames.push({
      id: 'delegate-frame-exact',
      parentFrameId: graph.rootFrameId,
      originMessageId: 'message-1',
      originBindingState: 'validated',
      kind: 'delegate',
      agentName: 'Research Agent',
      delegateName: 'Meta Analyst',
      status: 'running',
      activeBranchId: 'delegate-branch',
      createdAt: 300
    })
    graph.branches.push({
      id: 'delegate-branch',
      agentFrameId: 'delegate-frame-exact',
      headMessageId: 'delegate-message',
      createdAt: 300,
      updatedAt: 300
    })
    graph.messages.push({
      ...message('delegate-message', 'agent', 300),
      content: 'This body must never participate in catalog search: secretneedle',
      agentFrameId: 'delegate-frame-exact',
      introducedOnBranchId: 'delegate-branch'
    })
    const readSession = vi.fn(async () => ({ status: 'found' as const, session: target }))
    const readProject = vi.fn(async () => ({ sessions: [target], isComplete: true }))
    const service = new HostFramesService({ readProject, readSession })

    const result = (await service.list(
      {
        session_id: 'session-1',
        roots_only: false,
        kind: 'delegate',
        archived: 'include',
        search: 'mta',
        after: '1970-01-01T00:00:00.200Z',
        before: '1970-01-01T00:00:00.400Z'
      },
      context
    )) as { frames: Array<{ frame_id: string }> }

    expect(result.frames.map((frame) => frame.frame_id)).toEqual(['delegate-frame-exact'])
    expect(readSession).toHaveBeenCalledWith('project-a', 'session-1')
    expect(readProject).not.toHaveBeenCalled()
    await expect(
      service.list({ roots_only: false, search: 'secretneedle' }, context)
    ).resolves.toMatchObject({ total_count: 0 })
  })

  it('paginates a stable catalog with opaque filter-bound cursors and rejects stale snapshots', async () => {
    const sessions = ['one', 'two', 'three'].map((id, index) => {
      const item = session({ id, title: id, updatedAt: 300 - index * 100 })
      item.conversationGraph!.frames[0].createdAt = 300 - index * 100
      return item
    })
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions, isComplete: true })),
      readSession: vi.fn()
    })

    const first = (await service.list({ limit: 2 }, context)) as {
      total_count: number
      next_cursor?: string
      frames: Array<{ frame_id: string }>
    }
    expect(first).toMatchObject({ total_count: 3 })
    expect(first.frames.map((frame) => frame.frame_id)).toEqual([
      'root-frame-one',
      'root-frame-two'
    ])
    expect(first.next_cursor).toEqual(expect.any(String))

    await expect(service.list({ limit: 2, cursor: first.next_cursor }, context)).resolves.toEqual({
      project_id: 'project-a',
      total_count: 3,
      frames: [expect.objectContaining({ frame_id: 'root-frame-three' })]
    })
    await expect(
      service.list({ roots_only: false, limit: 2, cursor: first.next_cursor }, context)
    ).rejects.toThrow('cursor does not match')

    sessions[2].updatedAt += 1
    await expect(service.list({ limit: 2, cursor: first.next_cursor }, context)).rejects.toThrow(
      'cursor is no longer valid'
    )
  })

  it('uses the catalog and transcript default page limits', async () => {
    const catalogSessions = Array.from({ length: 21 }, (_, index) => {
      const item = session({ id: `catalog-${index}` })
      item.conversationGraph!.frames[0].createdAt = index
      return item
    })
    const catalog = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: catalogSessions, isComplete: true })),
      readSession: vi.fn()
    })
    const catalogPage = (await catalog.list({}, context)) as {
      total_count: number
      next_cursor?: string
      frames: unknown[]
    }
    expect(catalogPage).toMatchObject({
      total_count: 21,
      next_cursor: expect.any(String)
    })
    expect(catalogPage.frames).toHaveLength(20)

    const transcriptSession = session({
      messages: Array.from({ length: 45 }, (_, index) =>
        message(`message-${index + 1}`, index % 2 ? 'agent' : 'user', index + 1)
      )
    })
    const transcript = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [transcriptSession], isComplete: true })),
      readSession: vi.fn()
    })
    const result = (await transcript.get(
      transcriptSession.conversationGraph!.rootFrameId,
      {},
      context
    )) as { transcript: { messages: Array<{ message_id: string }>; previous_cursor?: string } }
    expect(result.transcript.messages).toHaveLength(40)
    expect(result.transcript.messages[0].message_id).toBe('message-6')
    expect(result.transcript.previous_cursor).toEqual(expect.any(String))
  })

  it('gets an exact Frame on its active Branch with a chronological sanitized transcript', async () => {
    const messages = [
      {
        ...message('prompt', 'user', 100),
        content: '<think>private user note</think>user prompt'
      },
      {
        ...message('response', 'agent', 200),
        content: '<think>private chain of thought</think>Visible answer',
        responseToMessageId: 'prompt',
        completedAt: 210,
        turnUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 5, turnCount: 1 }
      }
    ]
    const target = session({ messages, updatedAt: 220 })
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [target], isComplete: true })),
      readSession: vi.fn()
    })

    await expect(service.get('root-frame-session-1', {}, context)).resolves.toEqual({
      project_id: 'project-a',
      session: {
        session_id: 'session-1',
        session_title: 'Literature review',
        session_status: 'idle',
        created_at: new Date(100).toISOString(),
        updated_at: new Date(220).toISOString()
      },
      frame: {
        frame_id: 'root-frame-session-1',
        session_id: 'session-1',
        session_title: 'Literature review',
        kind: 'root',
        recorded_frame_status: 'completed',
        session_status: 'idle',
        created_at: new Date(100).toISOString(),
        completed_at: new Date(200).toISOString(),
        session_updated_at: new Date(220).toISOString(),
        message_count: 2,
        child_count: 0
      },
      branch: {
        branch_id: 'message-branch-session-1',
        created_at: new Date(100).toISOString(),
        updated_at: new Date(200).toISOString()
      },
      transcript: {
        messages: [
          {
            message_id: 'prompt',
            role: 'user',
            content: 'user prompt',
            status: 'complete',
            runtime_segment_id: 'runtime-segment-session-1',
            created_at: new Date(100).toISOString(),
            updated_at: new Date(100).toISOString()
          },
          {
            message_id: 'response',
            role: 'agent',
            content: 'Visible answer',
            status: 'complete',
            response_to_message_id: 'prompt',
            runtime_segment_id: 'runtime-segment-session-1',
            created_at: new Date(200).toISOString(),
            updated_at: new Date(200).toISOString(),
            completed_at: new Date(210).toISOString(),
            turn_usage: {
              input_tokens: 10,
              cache_tokens: 2,
              output_tokens: 5,
              turn_count: 1
            }
          }
        ],
        has_more_before: false
      },
      runtime_segments: [
        {
          runtime_segment_id: 'runtime-segment-session-1',
          started_at: new Date(100).toISOString()
        }
      ]
    })
  })

  it('resolves an explicitly selected non-active Branch by parent links instead of array order', async () => {
    const target = session({
      messages: [message('shared-prompt', 'user', 100), message('active-response', 'agent', 200)]
    })
    const graph = target.conversationGraph!
    graph.branches.push({
      id: 'alternative-branch',
      agentFrameId: graph.rootFrameId,
      headMessageId: 'alternative-response',
      createdAt: 150,
      updatedAt: 250
    })
    graph.messages.unshift({
      ...message('array-order-decoy', 'agent', 240),
      agentFrameId: graph.rootFrameId,
      introducedOnBranchId: 'alternative-branch'
    })
    graph.messages.push({
      ...message('alternative-response', 'agent', 250),
      agentFrameId: graph.rootFrameId,
      introducedOnBranchId: 'alternative-branch',
      parentMessageId: 'shared-prompt',
      runtimeSegmentId: graph.runtimeSegments[0].id
    })
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [target], isComplete: true })),
      readSession: vi.fn()
    })

    const result = (await service.get(
      graph.rootFrameId,
      { branch_id: 'alternative-branch' },
      context
    )) as { transcript: { messages: Array<{ message_id: string }> } }

    expect(result.transcript.messages.map((item) => item.message_id)).toEqual([
      'shared-prompt',
      'alternative-response'
    ])
  })

  it('pages backward from the latest Messages and rejects a stale transcript cursor', async () => {
    const target = session({
      messages: [1, 2, 3, 4, 5].map((index) =>
        message(`message-${index}`, index % 2 ? 'user' : 'agent', index * 100)
      )
    })
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [target], isComplete: true })),
      readSession: vi.fn()
    })
    const frameId = target.conversationGraph!.rootFrameId

    const first = (await service.get(frameId, { limit: 2 }, context)) as {
      transcript: {
        messages: Array<{ message_id: string }>
        previous_cursor?: string
        has_more_before: boolean
      }
    }
    expect(first.transcript.messages.map((item) => item.message_id)).toEqual([
      'message-4',
      'message-5'
    ])
    expect(first.transcript).toMatchObject({
      previous_cursor: expect.any(String),
      has_more_before: true
    })

    const second = (await service.get(
      frameId,
      { limit: 2, before: first.transcript.previous_cursor },
      context
    )) as typeof first
    expect(second.transcript.messages.map((item) => item.message_id)).toEqual([
      'message-2',
      'message-3'
    ])
    expect(second.transcript.has_more_before).toBe(true)

    const third = (await service.get(
      frameId,
      { limit: 2, before: second.transcript.previous_cursor },
      context
    )) as typeof first
    expect(third.transcript.messages.map((item) => item.message_id)).toEqual(['message-1'])
    expect(third.transcript).toMatchObject({ has_more_before: false })
    expect(third.transcript.previous_cursor).toBeUndefined()

    const graph = target.conversationGraph!
    graph.frames.push({
      id: 'other-frame',
      parentFrameId: graph.rootFrameId,
      originBindingState: 'legacy-unavailable',
      kind: 'compatibility',
      status: 'completed',
      activeBranchId: 'other-branch',
      createdAt: 600,
      completedAt: 600
    })
    graph.branches.push({
      id: 'other-branch',
      agentFrameId: 'other-frame',
      createdAt: 600,
      updatedAt: 600
    })
    await expect(
      service.get('other-frame', { limit: 2, before: first.transcript.previous_cursor }, context)
    ).rejects.toThrow('cursor does not match')
    await expect(service.get(frameId, { branch_id: 'other-branch' }, context)).rejects.toThrow(
      'Branch not found'
    )

    target.conversationGraph!.messages.find((item) => item.id === 'message-3')!.updatedAt += 1
    await expect(
      service.get(frameId, { limit: 2, before: first.transcript.previous_cursor }, context)
    ).rejects.toThrow('cursor is no longer valid')
  })

  it('requires full exact ids and uses Session narrowing to disambiguate within the Project', async () => {
    const first = session({ id: 'session-one', title: 'One' })
    const second = session({ id: 'session-two', title: 'Two' })
    renameRootFrame(first, 'shared-frame-exact')
    renameRootFrame(second, 'shared-frame-exact')
    const readSession = vi.fn(async (_projectId: string, sessionId: string) =>
      sessionId === 'session-two'
        ? { status: 'found' as const, session: second }
        : { status: 'missing' as const }
    )
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [first, second], isComplete: true })),
      readSession
    })

    await expect(service.get('shared-frame-exact', {}, context)).rejects.toThrow('ambiguous')
    await expect(
      service.get('shared-frame-exact', { session_id: 'session-two' }, context)
    ).resolves.toMatchObject({
      project_id: 'project-a',
      session: { session_id: 'session-two' },
      frame: { frame_id: 'shared-frame-exact' }
    })
    expect(readSession).toHaveBeenCalledWith('project-a', 'session-two')
    await expect(service.get('shared-frame', {}, context)).rejects.toThrow(
      'not found in the current Project'
    )
    await expect(
      service.get('shared-frame-exact', { session_id: 'wrong-session' }, context)
    ).rejects.toThrow('not found in the current Project')
  })

  it('projects safe attachment references without leaking paths, bytes, tools, or runtime internals', async () => {
    const user = message('prompt', 'user', 100)
    user.uploads = [
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'managed.csv',
        originalName: '/private/input/source.csv',
        mimeType: 'text/csv',
        size: 12,
        path: '/private/uploads/managed.csv'
      }
    ]
    user.images = [
      { id: 'image-1', mimeType: 'image/png', data: 'SECRET_IMAGE_BASE64', byteLength: 12 }
    ]
    user.parts = [
      {
        type: 'artifact',
        id: 'mention-1',
        name: 'private.csv',
        source: 'artifact',
        path: '/private/mentioned/private.csv'
      }
    ]
    const agent = {
      ...message('response', 'agent', 200),
      content: '<think>SECRET_REASONING</think>Safe answer',
      artifactIds: ['artifact-ref-1'],
      eventIds: ['SECRET_EVENT_ID'],
      streamId: 'SECRET_STREAM_ID'
    }
    const target = session({
      cwd: '/private/project/cwd',
      providerSessionId: 'SECRET_PROVIDER_SESSION',
      providerContinuityToken: 'SECRET_CONTINUITY_TOKEN',
      messages: [user, agent],
      artifacts: [
        {
          id: 'artifact-ref-1',
          artifactId: 'artifact-1',
          versionId: 'artifact-version-1',
          versionNumber: 1,
          kind: 'managed-file',
          name: '/private/generated/report.pdf',
          path: '/private/artifacts/report.pdf',
          mimeType: 'application/pdf',
          size: 42
        }
      ],
      activities: [
        {
          id: 'tool-1',
          kind: 'tool',
          title: 'SECRET_TOOL_TITLE',
          status: 'completed',
          sortIndex: 1,
          eventIds: [],
          rawInput: 'SECRET_RAW_INPUT',
          rawOutput: 'SECRET_RAW_OUTPUT',
          terminalOutput: 'SECRET_TERMINAL_OUTPUT',
          createdAt: 150,
          updatedAt: 160
        }
      ]
    })
    target.conversationGraph!.runtimeSegments[0] = {
      ...target.conversationGraph!.runtimeSegments[0],
      backendId: 'SECRET_BACKEND_ID',
      model: 'SECRET_MODEL',
      agentName: 'Visible Agent'
    }
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [target], isComplete: true })),
      readSession: vi.fn()
    })

    const result = (await service.get(target.conversationGraph!.rootFrameId, {}, context)) as {
      transcript: { messages: Array<{ message_id: string; attachments?: unknown[] }> }
    }
    expect(result.transcript.messages).toEqual([
      expect.objectContaining({
        message_id: 'prompt',
        attachments: [
          {
            kind: 'upload',
            attachment_id: 'upload-1',
            version_id: 'upload-version-1',
            name: 'source.csv',
            mime_type: 'text/csv',
            size_bytes: 12
          },
          {
            kind: 'image',
            attachment_id: 'image-1',
            name: 'Image 1',
            mime_type: 'image/png'
          }
        ]
      }),
      expect.objectContaining({
        message_id: 'response',
        content: 'Safe answer',
        attachments: [
          {
            kind: 'artifact',
            attachment_id: 'artifact-ref-1',
            version_id: 'artifact-version-1',
            name: 'report.pdf',
            mime_type: 'application/pdf',
            size_bytes: 42
          }
        ]
      })
    ])
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET_|\/private|rawInput|rawOutput|terminalOutput|streamId|eventIds|providerSessionId|providerContinuityToken|backendId|model/u
    )
  })

  it('fails explicitly for unreadable Session authority while retaining readable list results', async () => {
    const readable = session()
    const projectScoped = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [readable], isComplete: false })),
      readSession: vi.fn()
    })
    await expect(projectScoped.list({}, context)).resolves.toMatchObject({ total_count: 1 })
    await expect(
      projectScoped.get(readable.conversationGraph!.rootFrameId, {}, context)
    ).rejects.toThrow('Session is unreadable')

    const narrowed = new HostFramesService({
      readProject: vi.fn(),
      readSession: vi.fn(async () => ({ status: 'unreadable' as const }))
    })
    await expect(narrowed.list({ session_id: 'broken' }, context)).rejects.toThrow(
      'Session is unreadable'
    )
    await expect(narrowed.get('unknown-frame', { session_id: 'broken' }, context)).rejects.toThrow(
      'Session is unreadable'
    )
  })

  it('reads only an explicitly authorized cross-Project Session id', async () => {
    const referenced = session({ id: 'session-b', projectId: 'project-b', title: 'Other result' })
    const readSession = vi.fn(async (projectId: string, sessionId: string) =>
      projectId === 'project-b' && sessionId === referenced.id
        ? { status: 'found' as const, session: referenced }
        : { status: 'missing' as const }
    )
    const resolveReference = vi.fn(async (_context, sessionId: string) =>
      sessionId === referenced.id ? { projectId: 'project-b' } : undefined
    )
    const service = new HostFramesService({ readProject: vi.fn(), readSession }, resolveReference)

    await expect(
      service.list({ session_id: referenced.id, roots_only: true }, context)
    ).resolves.toMatchObject({
      project_id: 'project-b',
      total_count: 1,
      frames: [expect.objectContaining({ session_id: referenced.id })]
    })
    await expect(
      service.get(referenced.conversationGraph!.rootFrameId, { session_id: referenced.id }, context)
    ).resolves.toMatchObject({
      project_id: 'project-b',
      session: { session_id: referenced.id, session_title: 'Other result' }
    })
    await expect(service.list({ session_id: 'not-authorized' }, context)).resolves.toMatchObject({
      project_id: 'project-a',
      total_count: 0
    })
    expect(readSession).not.toHaveBeenCalledWith('project-b', 'not-authorized')
  })

  it('rejects malformed and authority-bearing options at the Module interface', async () => {
    const target = session()
    const service = new HostFramesService({
      readProject: vi.fn(async () => ({ sessions: [target], isComplete: true })),
      readSession: vi.fn()
    })
    for (const options of [
      null,
      { project_id: 'other' },
      { roots_only: 'yes' },
      { kind: 'unknown' },
      { archived: 'yes' },
      { after: '2026-02-30' },
      { after: '2026-02-30T00:00:00Z' },
      { before: '2025-02-29T12:00:00+08:00' },
      { after: '2026-08-03', before: '2026-08-03' },
      { after: '2026-08-03T10:00:00' },
      { limit: 0 },
      { limit: 101 },
      { cursor: 'not-a-cursor' }
    ]) {
      await expect(service.list(options, context)).rejects.toThrow(/host\.frames\.list/u)
    }
    await expect(service.get('', {}, context)).rejects.toThrow(/frame_id/u)
    for (const options of [
      null,
      { project_id: 'other' },
      { session_id: 1 },
      { branch_id: 1 },
      { limit: 0 },
      { limit: 101 },
      { before: 'not-a-cursor' }
    ]) {
      await expect(
        service.get(target.conversationGraph!.rootFrameId, options, context)
      ).rejects.toThrow(/host\.frames\.get/u)
    }
  })
})
