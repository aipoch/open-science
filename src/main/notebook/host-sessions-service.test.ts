import { describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { AcpStateSnapshot } from '../../shared/acp'
import {
  normalizeSessionFile,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { HostSessionsService, type HostSessionsRepository } from './host-sessions-service'

const message = (id: string, createdAt: number): PersistedChatMessage => ({
  id,
  role: 'user',
  content: `message ${id}`,
  status: 'complete',
  eventIds: [],
  createdAt,
  updatedAt: createdAt
})

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => {
  const id = overrides.id ?? 'session-1'
  const messages = overrides.messages ?? [message('message-1', 100)]
  return {
    id,
    projectId: 'project-a',
    title: 'Literature review',
    cwd: '/private/workspace',
    status: 'running',
    messages,
    conversationGraph: createLinearConversationGraph({
      sessionId: id,
      messages,
      frameworkId: 'claude-code',
      createdAt: 100,
      updatedAt: 200
    }),
    activeRun: { promptMessageId: messages[0].id, startedAt: 150 },
    createdAt: 100,
    updatedAt: 200,
    ...overrides
  }
}

const snapshot = (overrides: Partial<AcpStateSnapshot> = {}): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/private/workspace',
  sessionIds: ['session-1'],
  events: [
    {
      id: 'event-1',
      sessionId: 'session-1',
      timestamp: 175,
      kind: 'tool',
      level: 'info',
      status: 'in_progress',
      title: '/private/SECRET command',
      rawInput: { token: 'SECRET' }
    }
  ],
  pendingPermissions: [
    {
      requestId: 'permission-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Private permission',
      options: []
    }
  ],
  pendingElicitations: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: true,
  agentPromptInFlightSessionIds: ['session-1'],
  promptInFlightSessionIds: ['session-1'],
  sessionConnectionStatuses: { 'session-1': 'connected' },
  ...overrides
})

const context = {
  projectId: 'project-a',
  sessionId: 'calling-session',
  callerRole: 'main' as const
}

const repository = (sessions: PersistedChatSession[]): HostSessionsRepository => ({
  readProject: vi.fn(async () => ({ sessions, isComplete: true })),
  readSession: vi.fn(async (_projectId, sessionId) => {
    const found = sessions.find((candidate) => candidate.id === sessionId)
    return found ? { status: 'found' as const, session: found } : { status: 'missing' as const }
  })
})

describe('HostSessionsService', () => {
  it('lists current-Project Sessions with live evidence and host.frames navigation only', async () => {
    const service = new HostSessionsService(repository([session()]), {
      getSnapshot: () => snapshot()
    })

    await expect(service.list({}, context)).resolves.toEqual({
      total_count: 1,
      sessions: [
        {
          session_id: 'session-1',
          title: 'Literature review',
          status: 'running',
          created_at: new Date(100).toISOString(),
          updated_at: new Date(200).toISOString(),
          active_run_started_at: new Date(150).toISOString(),
          runtime: {
            attached: true,
            connection_status: 'connected',
            prompt_in_flight: true,
            agent_prompt_in_flight: true,
            permission_pending: true,
            user_input_pending: false
          },
          active_conversation: {
            frame_id: 'root-frame-session-1',
            branch_id: 'message-branch-session-1',
            message_count: 1
          },
          latest_observation: {
            timestamp: new Date(175).toISOString(),
            kind: 'tool',
            level: 'info',
            status: 'in_progress'
          }
        }
      ]
    })
    expect(JSON.stringify(await service.list({}, context))).not.toMatch(/SECRET|\/private/u)
  })

  it('inspects an explicitly authorized cross-Project Session without widening list scope', async () => {
    const referenced = session({ id: 'session-b', projectId: 'project-b', title: 'Other result' })
    const repo: HostSessionsRepository = {
      readProject: vi.fn(async () => ({ sessions: [], isComplete: true })),
      readSession: vi.fn(async (projectId, sessionId) =>
        projectId === 'project-b' && sessionId === referenced.id
          ? { status: 'found' as const, session: referenced }
          : { status: 'missing' as const }
      )
    }
    const service = new HostSessionsService(
      repo,
      { getSnapshot: () => snapshot() },
      async (_context, sessionId) =>
        sessionId === referenced.id ? { projectId: 'project-b' } : undefined
    )

    await expect(service.inspect(referenced.id, context)).resolves.toMatchObject({
      session_id: referenced.id,
      title: 'Other result'
    })
    await expect(service.list({}, context)).resolves.toEqual({ total_count: 0, sessions: [] })
    await expect(service.inspect('not-authorized', context)).rejects.toThrow(
      'not found in the current Project'
    )
  })

  it('projects the graph active Frame instead of forcing root Frame navigation', async () => {
    const target = session()
    const graph = target.conversationGraph!
    graph.frames.push({
      id: 'reviewer-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: 'message-1',
      originBindingState: 'validated',
      kind: 'reviewer',
      status: 'running',
      activeBranchId: 'reviewer-branch',
      createdAt: 201
    })
    graph.branches.push({
      id: 'reviewer-branch',
      agentFrameId: 'reviewer-frame',
      headMessageId: 'reviewer-message',
      createdAt: 201,
      updatedAt: 202
    })
    graph.messages.push({
      ...message('reviewer-message', 202),
      agentFrameId: 'reviewer-frame',
      introducedOnBranchId: 'reviewer-branch'
    })
    graph.activeFrameId = 'reviewer-frame'
    const service = new HostSessionsService(repository([target]), {
      getSnapshot: () => undefined
    })

    await expect(service.inspect('session-1', context)).resolves.toMatchObject({
      active_conversation: {
        frame_id: 'reviewer-frame',
        branch_id: 'reviewer-branch',
        message_count: 1
      }
    })
  })

  it('filters, orders, and paginates the Session catalog with snapshot-bound cursors', async () => {
    const sessions = [
      session({ id: 'session-b', title: 'Genomics beta', updatedAt: 300 }),
      session({ id: 'session-a', title: 'Genomics alpha', updatedAt: 300 }),
      session({ id: 'session-c', title: 'Unrelated', updatedAt: 100 }),
      session({ id: 'session-special-identity', title: 'Identity only', updatedAt: 100 }),
      session({
        id: 'session-archived',
        title: 'Genomics archive',
        archivedAt: 400,
        updatedAt: 400
      })
    ]
    const service = new HostSessionsService(repository(sessions), {
      getSnapshot: () => snapshot({ sessionIds: [], events: [], pendingPermissions: [] })
    })

    const first = (await service.list({ search: 'gen', limit: 1 }, context)) as {
      total_count: number
      next_cursor?: string
      sessions: Array<{ session_id: string }>
    }
    expect(first).toMatchObject({ total_count: 2, next_cursor: expect.any(String) })
    expect(first.sessions.map((item) => item.session_id)).toEqual(['session-a'])

    await expect(
      service.list({ search: 'gen', limit: 1, cursor: first.next_cursor }, context)
    ).resolves.toMatchObject({
      total_count: 2,
      sessions: [expect.objectContaining({ session_id: 'session-b' })]
    })
    await expect(service.list({ archived: 'only', search: 'gen' }, context)).resolves.toMatchObject(
      {
        total_count: 1,
        sessions: [expect.objectContaining({ session_id: 'session-archived' })]
      }
    )
    await expect(
      service.list({ archived: 'include', search: 'gen' }, context)
    ).resolves.toMatchObject({ total_count: 3 })
    await expect(service.list({ search: 'special' }, context)).resolves.toMatchObject({
      total_count: 0,
      sessions: []
    })
    await expect(
      service.list({ search: 'session-special-identity' }, context)
    ).resolves.toMatchObject({
      total_count: 1,
      sessions: [expect.objectContaining({ session_id: 'session-special-identity' })]
    })
    await expect(service.list({ limit: 2, cursor: first.next_cursor }, context)).rejects.toThrow(
      'cursor does not match'
    )

    sessions[1].updatedAt += 1
    await expect(
      service.list({ search: 'gen', limit: 1, cursor: first.next_cursor }, context)
    ).rejects.toThrow('cursor is no longer valid')
  })

  it('inspects one exact Session without scanning or returning transcript content', async () => {
    const target = session({ id: 'target-session' })
    const repo = repository([target])
    const service = new HostSessionsService(repo, {
      getSnapshot: () => snapshot({ sessionIds: [], events: [], pendingPermissions: [] })
    })

    const result = await service.inspect('target-session', context)

    expect(result).toMatchObject({
      session_id: 'target-session',
      active_conversation: {
        frame_id: 'root-frame-target-session',
        branch_id: 'message-branch-target-session'
      },
      runtime: { attached: false }
    })
    expect(repo.readSession).toHaveBeenCalledWith('project-a', 'target-session')
    expect(repo.readProject).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(/message message-1|transcript|messages/u)
  })

  it('fails closed for incomplete authority, unreadable exact Sessions, and non-Main callers', async () => {
    const target = session()
    const incomplete = new HostSessionsService(
      {
        readProject: vi.fn(async () => ({ sessions: [target], isComplete: false })),
        readSession: vi.fn(async () => ({ status: 'unreadable' as const }))
      },
      { getSnapshot: () => undefined }
    )

    await expect(incomplete.list({}, context)).rejects.toThrow('cannot complete')
    await expect(incomplete.inspect('session-1', context)).rejects.toThrow('unreadable')
    await expect(incomplete.list({}, { ...context, callerRole: 'delegate' })).rejects.toThrow(
      'Main only'
    )
    await expect(
      incomplete.inspect('session-1', { ...context, callerRole: 'delegate' })
    ).rejects.toThrow('Main only')

    const missing = new HostSessionsService(
      {
        readProject: vi.fn(),
        readSession: vi.fn(async () => ({ status: 'missing' as const }))
      },
      { getSnapshot: () => undefined }
    )
    await expect(missing.inspect('session-1', context)).rejects.toThrow(
      'not found in the current Project'
    )
  })

  it('rejects malformed and authority-bearing inputs at the Module boundary', async () => {
    const service = new HostSessionsService(repository([session()]), {
      getSnapshot: () => undefined
    })
    for (const options of [
      null,
      { project_id: 'other' },
      { archived: 'invalid' },
      { search: '' },
      { limit: 0 },
      { limit: 101 },
      { cursor: 'not-a-cursor' }
    ]) {
      await expect(service.list(options, context)).rejects.toThrow(/host\.sessions\.list/u)
    }
    for (const sessionId of ['', 1, 'x'.repeat(513)]) {
      await expect(service.inspect(sessionId, context)).rejects.toThrow(/session_id/u)
    }
  })

  it('omits provider-defined observation status values instead of exporting payload text', async () => {
    const service = new HostSessionsService(repository([session()]), {
      getSnapshot: () =>
        snapshot({
          events: [
            {
              id: 'event-private-status',
              sessionId: 'session-1',
              timestamp: 200,
              kind: 'raw',
              level: 'warning',
              status: 'SECRET_PROVIDER_VALUE',
              raw: { status: 'SECRET_PROVIDER_VALUE' }
            }
          ],
          pendingPermissions: []
        })
    })

    const result = await service.inspect('session-1', context)

    expect(result).toMatchObject({
      latest_observation: {
        timestamp: new Date(200).toISOString(),
        kind: 'raw',
        level: 'warning'
      }
    })
    expect(JSON.stringify(result)).not.toContain('SECRET_PROVIDER_VALUE')
  })

  it('uses the existing legacy Session normalization for host.frames navigation identifiers', async () => {
    const legacy = session()
    delete legacy.conversationGraph
    const normalized = normalizeSessionFile(legacy, { preserveRuntimeState: true })
    expect(normalized).toBeDefined()
    const service = new HostSessionsService(repository([normalized!]), {
      getSnapshot: () => undefined
    })

    await expect(service.inspect('session-1', context)).resolves.toMatchObject({
      active_conversation: {
        frame_id: 'root-frame-session-1',
        branch_id: 'message-branch-session-1',
        message_count: 1
      }
    })
  })
})
