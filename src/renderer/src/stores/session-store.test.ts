import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../../shared/artifacts'
import {
  INTERRUPTED_SESSION_ERROR,
  SESSION_MANIFEST_VERSION,
  type PersistedChatSession
} from '../../../shared/session-persistence'
import type { UploadedAttachment } from '../../../shared/uploads'
import { createInitialSessionState, toPersistedSession, useSessionStore } from './session-store'

const createArtifactFile = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
  id: 'artifact-session-1:run-1:result.txt',
  projectName: 'default-project',
  sessionId: 'artifact-session-1',
  runId: 'run-1',
  name: 'result.txt',
  path: '/Users/example/.open-science/artifacts/default-project/artifact-session-1/.pending/run-1/result.txt',
  fileUrl:
    'file:///Users/example/.open-science/artifacts/default-project/artifact-session-1/.pending/run-1/result.txt',
  size: 2,
  mtimeMs: 1710000000000,
  ...overrides
})

const createUploadAttachment = (
  overrides: Partial<UploadedAttachment> = {}
): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: '.pending',
  name: 'first.png',
  originalName: 'first.png',
  path: '/Users/example/.open-science/uploads/default-project/.pending/first.png',
  mimeType: 'image/png',
  size: 1234,
  ...overrides
})

describe('session store', () => {
  // Reset time and state so each store assertion starts from the same baseline.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    useSessionStore.setState(createInitialSessionState())
  })

  it('starts empty so New can stay outside store state', () => {
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('uses the provided session id when the first user message creates a session', () => {
    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Help me inspect this notebook',
      cwd: '/workspace/project'
    })

    expect(result?.sessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({
        id: 'transport-session-1',
        cwd: '/workspace/project',
        title: 'Help me inspect this notebook',
        status: 'running',
        activeRun: {
          promptMessageId: result?.messageId,
          startedAt: Date.now()
        },
        messages: [
          expect.objectContaining({
            id: result?.messageId,
            role: 'user',
            content: 'Help me inspect this notebook',
            status: 'complete'
          })
        ]
      })
    ])
  })

  it('creates a pending first message before a runtime session id exists', () => {
    const result = useSessionStore.getState().appendPendingUserMessage({
      content: 'Help me inspect this notebook',
      cwd: '/workspace/project'
    })

    expect(result?.sessionId).toMatch(/^pending-session-/)
    expect(useSessionStore.getState().selectedSessionId).toBe(result?.sessionId)
    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({
        id: result?.sessionId,
        isPending: true,
        cwd: '/workspace/project',
        title: 'Help me inspect this notebook',
        status: 'running',
        activeRun: {
          promptMessageId: result?.messageId,
          startedAt: Date.now()
        },
        messages: [
          expect.objectContaining({
            id: result?.messageId,
            role: 'user',
            content: 'Help me inspect this notebook',
            status: 'complete'
          })
        ]
      })
    ])
  })

  it('stores uploaded attachments on user messages in insertion order', () => {
    const firstUpload = createUploadAttachment({ id: 'upload-1', name: 'first.png' })
    const secondUpload = createUploadAttachment({
      id: 'upload-2',
      name: 'second.png',
      originalName: 'second.png',
      path: '/Users/example/.open-science/uploads/default-project/.pending/second.png'
    })

    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Describe these',
      cwd: '/workspace/project',
      attachments: [firstUpload, secondUpload]
    })

    expect(useSessionStore.getState().sessions[0].messages[0]).toMatchObject({
      id: result?.messageId,
      role: 'user',
      content: 'Describe these',
      uploads: [
        expect.objectContaining({ id: 'upload-1', name: 'first.png' }),
        expect.objectContaining({ id: 'upload-2', name: 'second.png' })
      ]
    })
  })

  it('allows an attachments-only user message and replaces uploads after session binding', () => {
    const pendingUpload = createUploadAttachment()
    const finalizedUpload = createUploadAttachment({
      sessionId: 'transport-session-1',
      path: '/Users/example/.open-science/uploads/default-project/transport-session-1/first.png'
    })
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: '',
      cwd: '/workspace/project',
      attachments: [pendingUpload]
    })

    useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending?.sessionId ?? '',
      sessionId: 'transport-session-1',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().replaceMessageUploads({
      sessionId: 'transport-session-1',
      messageId: pending?.messageId ?? '',
      uploads: [finalizedUpload]
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'transport-session-1',
      title: 'Attached first.png',
      messages: [
        expect.objectContaining({
          id: pending?.messageId,
          content: '',
          uploads: [
            expect.objectContaining({
              id: 'upload-1',
              sessionId: 'transport-session-1',
              path: finalizedUpload.path
            })
          ]
        })
      ]
    })
  })

  it('binds a pending session to the runtime session id without rewriting the prompt', () => {
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: 'Help me inspect this notebook',
      cwd: '/workspace/project'
    })

    const bound = useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending?.sessionId ?? '',
      sessionId: 'transport-session-1',
      cwd: '/workspace/project'
    })

    expect(bound).toEqual({
      sessionId: 'transport-session-1',
      messageId: pending?.messageId
    })
    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({
        id: 'transport-session-1',
        isPending: false,
        cwd: '/workspace/project',
        status: 'running',
        activeRun: {
          promptMessageId: pending?.messageId,
          startedAt: Date.now()
        },
        messages: [
          expect.objectContaining({
            id: pending?.messageId,
            content: 'Help me inspect this notebook'
          })
        ]
      })
    ])
  })

  it('appends follow-up user messages to the same session and restarts the run', () => {
    const first = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Start a pathway analysis'
    })

    const second = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Add enrichment notes'
    })

    const session = useSessionStore.getState().sessions[0]

    expect(first?.sessionId).toBe('transport-session-1')
    expect(second?.sessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(session.status).toBe('running')
    expect(session.activeRun).toEqual({
      promptMessageId: second?.messageId,
      startedAt: Date.now()
    })
    expect(session.messages.map((message) => message.content)).toEqual([
      'Start a pathway analysis',
      'Add enrichment notes'
    ])
  })

  it('merges streamed agent chunks by stream id and completes them when the run stops', () => {
    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Summarize the dataset'
    })

    const firstChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })

    const secondChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-2',
      content: ' complete'
    })

    useSessionStore.getState().finishRun('transport-session-1')

    const session = useSessionStore.getState().sessions[0]
    const agentMessage = session.messages[1]

    expect(secondChunk?.messageId).toBe(firstChunk?.messageId)
    expect(agentMessage).toMatchObject({
      id: firstChunk?.messageId,
      role: 'agent',
      content: 'Summary complete',
      streamId: 'assistant-message-1',
      responseToMessageId: result?.messageId,
      eventIds: ['event-1', 'event-2'],
      status: 'complete'
    })
    expect(session.status).toBe('idle')
    expect(session.activeRun).toBeUndefined()
  })

  it('ignores duplicate streamed event ids for the same agent message', () => {
    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Summarize the dataset'
    })

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })

    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      content: 'Summary',
      responseToMessageId: result?.messageId,
      eventIds: ['event-1']
    })
  })

  it('keeps session state unchanged when a duplicate streamed event arrives after finish', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Summarize the dataset'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    const finishedSession = useSessionStore.getState().sessions[0]

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })

    expect(useSessionStore.getState().sessions[0]).toEqual(finishedSession)
  })

  it('marks the active run and streaming agent message as failed', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Read the files'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'I started'
    })

    useSessionStore.getState().failRun('transport-session-1', 'Permission denied')

    const session = useSessionStore.getState().sessions[0]

    expect(session.status).toBe('error')
    expect(session.error).toBe('Permission denied')
    expect(session.activeRun).toBeUndefined()
    expect(session.messages[1]).toMatchObject({
      content: 'I started',
      status: 'error'
    })
  })

  it('keeps artifact finalization errors visible when the run later stops', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Created it'
    })

    useSessionStore.getState().recordArtifactError('transport-session-1', 'move failed')
    useSessionStore.getState().finishRun('transport-session-1')

    const session = useSessionStore.getState().sessions[0]

    expect(session.status).toBe('error')
    expect(session.error).toBe('Generated file finalization failed: move failed')
    expect(session.activeRun).toBeUndefined()
    expect(session.messages[1].status).toBe('complete')
  })

  it('tracks permission waiting without losing the active run', () => {
    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Edit the file'
    })

    useSessionStore.getState().setPermissionPending('transport-session-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      activeRun: {
        promptMessageId: result?.messageId,
        startedAt: Date.now()
      }
    })

    useSessionStore.getState().clearPermissionPending('transport-session-1')
    expect(useSessionStore.getState().sessions[0].status).toBe('running')
  })

  it('upserts transient tool activities without duplicating repeated events', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'fetch',
      providerToolName: 'WebSearch',
      title: '"open science repositories"',
      status: 'pending'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      status: 'completed'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      status: 'completed'
    })

    expect(useSessionStore.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        id: 'tool-web-1',
        kind: 'tool',
        toolKind: 'fetch',
        providerToolName: 'WebSearch',
        title: '"open science repositories"',
        status: 'completed',
        eventIds: ['event-1', 'event-2']
      })
    ])
  })

  it('preserves tool activity content and locations across updates', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'fetch',
      providerToolName: 'WebSearch',
      title: '"open science repositories"',
      status: 'pending',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Searching web'
          }
        }
      ],
      toolLocations: [
        {
          path: 'https://example.com'
        }
      ]
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      providerToolName: 'WebSearch',
      status: 'completed'
    })

    expect(useSessionStore.getState().sessions[0].activities?.[0]).toMatchObject({
      providerToolName: 'WebSearch',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Searching web'
          }
        }
      ],
      toolLocations: [
        {
          path: 'https://example.com'
        }
      ],
      status: 'completed'
    })
  })

  it('merges raw input, raw output, and terminal metadata across tool updates', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Run the tests'
    })

    // The initial tool_call carries arguments; later updates stream output and exit metadata.
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-bash-1',
      eventId: 'event-1',
      toolKind: 'execute',
      providerToolName: 'Bash',
      title: 'npm test',
      status: 'pending',
      rawInput: { command: 'npm test' }
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-bash-1',
      eventId: 'event-2',
      terminalOutput: 'All tests passed',
      terminalExitCode: 0
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-bash-1',
      eventId: 'event-3',
      status: 'completed',
      rawOutput: { stdout: 'All tests passed' }
    })

    expect(useSessionStore.getState().sessions[0].activities?.[0]).toMatchObject({
      rawInput: { command: 'npm test' },
      rawOutput: { stdout: 'All tests passed' },
      terminalOutput: 'All tests passed',
      terminalExitCode: 0,
      status: 'completed'
    })
  })

  it('keeps missing web activity titles empty so the UI can render only the web verb', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'search',
      status: 'pending'
    })

    expect(useSessionStore.getState().sessions[0].activities?.[0]).toMatchObject({
      title: ''
    })
  })

  it('does not revive finished sessions or regress terminal tool activity statuses', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'fetch',
      title: '"open science repositories"',
      status: 'completed'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      status: 'pending'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      activities: [
        expect.objectContaining({
          status: 'completed',
          eventIds: ['event-1', 'event-2']
        })
      ]
    })
  })

  it('ignores stale new tool activities after a run has finished or failed', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'stale-tool-after-finish',
      eventId: 'event-1',
      toolKind: 'fetch',
      status: 'pending'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      activities: undefined
    })

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Try again'
    })
    useSessionStore.getState().failRun('transport-session-1', 'Network failed')

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'stale-tool-after-error',
      eventId: 'event-2',
      toolKind: 'search',
      status: 'in_progress'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      activities: undefined
    })
  })

  it('persists a bounded projection of tool activities in session snapshots', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Save this',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'fetch',
      title: '"open science repositories"',
      status: 'pending'
    })

    const persistedSession = toPersistedSession(useSessionStore.getState().sessions[0])

    expect(persistedSession.activities).toEqual([
      expect.objectContaining({
        id: 'tool-web-1',
        kind: 'tool',
        title: '"open science repositories"',
        status: 'pending',
        toolKind: 'fetch'
      })
    ])
  })

  it('drops oversized raw payloads from persisted activities but keeps the row', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Save a big file'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-save-1',
      eventId: 'event-1',
      toolKind: 'other',
      providerToolName: 'write_artifact_file',
      title: 'Write artifact file',
      status: 'completed',
      // A base64 file payload far exceeds the raw-input cap and must not be persisted.
      toolContent: undefined
    })
    // Inject an oversized rawInput directly on the stored activity to exercise the cap.
    const bigActivity = useSessionStore
      .getState()
      .sessions[0].activities?.find((activity) => activity.id === 'tool-save-1')

    expect(bigActivity).toBeDefined()

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'transport-session-1'
          ? {
              ...session,
              activities: session.activities?.map((activity) =>
                activity.id === 'tool-save-1'
                  ? { ...activity, rawInput: { filename: 'big.png', content: 'A'.repeat(50_000) } }
                  : activity
              )
            }
          : session
      )
    }))

    const persistedActivity = toPersistedSession(useSessionStore.getState().sessions[0])
      .activities?.[0]

    expect(persistedActivity?.id).toBe('tool-save-1')
    expect(persistedActivity?.rawInput).toBeUndefined()
  })

  it('restores persisted tool activities when hydrating sessions', () => {
    useSessionStore.getState().hydrateSessions(
      [
        {
          id: 'restored-session',
          projectId: 'default',
          title: 'Restored',
          cwd: '/workspace',
          status: 'idle',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'run it',
              status: 'complete',
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            }
          ],
          activities: [
            {
              id: 'activity-1',
              kind: 'tool',
              title: 'ls -la',
              status: 'completed',
              sortIndex: 2,
              eventIds: ['event-1'],
              providerToolName: 'Bash',
              toolKind: 'execute',
              createdAt: 2,
              updatedAt: 2
            }
          ],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      { version: SESSION_MANIFEST_VERSION, lastSessionId: 'restored-session' }
    )

    expect(useSessionStore.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        id: 'activity-1',
        kind: 'tool',
        title: 'ls -la',
        status: 'completed',
        providerToolName: 'Bash',
        toolKind: 'execute'
      })
    ])
  })

  // Note: normalizing interrupted (open) activities to "failed" now happens at the repository load
  // boundary (sanitizeSession), covered by the session-persistence repository round-trip test.

  it('ignores streamed agent chunks for missing sessions', () => {
    const result = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'missing-session',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'stale'
    })

    expect(result).toBeUndefined()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('renames and deletes sessions while keeping selection valid', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'First session'
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-2',
      content: 'Second session'
    })

    useSessionStore.getState().renameSession('transport-session-1', 'Renamed session')
    useSessionStore.getState().deleteSession('transport-session-2')

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].title).toBe('Renamed session')
    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
  })

  it("keeps selection within the deleted session's project", () => {
    useSessionStore
      .getState()
      .appendUserMessage({ sessionId: 'a-1', content: 'A one', projectId: 'project-a' })
    useSessionStore
      .getState()
      .appendUserMessage({ sessionId: 'a-2', content: 'A two', projectId: 'project-a' })
    useSessionStore
      .getState()
      .appendUserMessage({ sessionId: 'b-1', content: 'B one', projectId: 'project-b' })

    // Select and delete a session in project A while project B holds the globally newest session.
    useSessionStore.getState().selectSession('a-2')
    useSessionStore.getState().deleteSession('a-2')

    // Selection falls back to the remaining project-a session, never to project-b's newer 'b-1'.
    expect(useSessionStore.getState().selectedSessionId).toBe('a-1')
  })

  it('removes all sessions for a deleted project and repairs selection', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'keep-1',
      content: 'Keep',
      projectId: 'project-keep'
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'drop-1',
      content: 'Drop one',
      projectId: 'project-drop'
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'drop-2',
      content: 'Drop two',
      projectId: 'project-drop'
    })
    // Selection is currently on a session that belongs to the project being removed.
    expect(useSessionStore.getState().selectedSessionId).toBe('drop-2')

    useSessionStore.getState().removeSessionsForProject('project-drop')

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['keep-1'])
    expect(useSessionStore.getState().selectedSessionId).toBe('keep-1')
  })

  it('clears selection without deleting sessions', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Keep this session'
    })

    useSessionStore.getState().clearSelection()

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('attaches generated artifacts to the current agent message', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    const agentChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Done'
    })

    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    const session = useSessionStore.getState().sessions[0]
    const agentMessage = session.messages[1]

    expect(attached?.messageId).toBe(agentChunk?.messageId)
    expect(agentMessage.artifactIds).toEqual(['artifact-session-1:run-1:result.txt'])
    expect(agentMessage.content).toBe('Done')
    expect(session.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-session-1:run-1:result.txt',
        kind: 'managed-file',
        path: expect.stringContaining('/.pending/run-1/result.txt'),
        fileUrl: expect.stringContaining('file:///')
      })
    ])
  })

  it('creates a file-only agent message when a run emits artifacts without text', () => {
    const userMessage = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create an image'
    })

    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile({ name: 'image.png', mimeType: 'image/png' })]
    })

    useSessionStore.getState().finishRun('transport-session-1')

    const message = useSessionStore.getState().sessions[0].messages[1]

    expect(attached?.messageId).toBe(message.id)
    expect(message).toMatchObject({
      role: 'agent',
      content: '',
      status: 'complete',
      streamId: 'run-1',
      responseToMessageId: userMessage?.messageId,
      artifactIds: ['artifact-session-1:run-1:result.txt']
    })
  })

  it('replaces pending artifact metadata with finalized message files', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    useSessionStore.getState().replaceMessageArtifacts({
      sessionId: 'transport-session-1',
      messageId: attached?.messageId ?? '',
      artifacts: [
        createArtifactFile({
          id: 'transport-session-1:message-1:result.txt',
          sessionId: 'transport-session-1',
          messageId: 'message-1',
          runId: undefined,
          path: '/Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt',
          fileUrl:
            'file:///Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt'
        })
      ]
    })

    const session = useSessionStore.getState().sessions[0]
    const message = session.messages[1]

    expect(message.artifactIds).toEqual(['transport-session-1:message-1:result.txt'])
    expect(session.artifacts?.map((artifact) => artifact.id)).toEqual([
      'transport-session-1:message-1:result.txt'
    ])
  })

  it('replaces pending artifact metadata with an empty finalized artifact list', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    useSessionStore.getState().replaceMessageArtifacts({
      sessionId: 'transport-session-1',
      messageId: attached?.messageId ?? '',
      artifacts: []
    })

    const session = useSessionStore.getState().sessions[0]
    const message = session.messages[1]

    expect(message.artifactIds).toEqual([])
    expect(session.artifacts).toEqual([])
  })

  it('returns the existing message when an artifact event is replayed after finish', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    const agentChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Done'
    })
    const firstAttached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    expect(firstAttached).toEqual(agentChunk)
    useSessionStore.getState().finishRun('transport-session-1')
    const finishedSession = useSessionStore.getState().sessions[0]

    const replayed = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    expect(replayed).toEqual(firstAttached)
    expect(useSessionStore.getState().sessions[0]).toEqual(finishedSession)
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(2)
  })

  it('hydrates persisted sessions and repairs missing selections', () => {
    useSessionStore.getState().hydrateSessions(
      [
        {
          id: 'transport-session-1',
          projectId: 'default',
          title: 'Persisted session',
          cwd: '/workspace/project',
          status: 'idle',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Persisted prompt',
              status: 'complete',
              eventIds: [],
              uploads: [
                {
                  id: 'upload-1',
                  sessionId: 'transport-session-1',
                  name: 'notes.txt',
                  originalName: 'notes.txt',
                  path: '/Users/example/.open-science/uploads/default-project/transport-session-1/notes.txt',
                  mimeType: 'text/plain',
                  size: 10
                }
              ],
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
          ],
          artifacts: [
            {
              id: 'artifact-1',
              kind: 'workspace-file',
              path: '/workspace/project/report.md',
              name: 'report.md'
            }
          ],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ],
      { version: SESSION_MANIFEST_VERSION, lastSessionId: 'missing-session' }
    )

    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'transport-session-1',
      cwd: '/workspace/project',
      artifacts: [
        {
          id: 'artifact-1',
          path: '/workspace/project/report.md'
        }
      ],
      messages: [
        {
          content: 'Persisted prompt',
          uploads: [
            {
              id: 'upload-1',
              path: '/Users/example/.open-science/uploads/default-project/transport-session-1/notes.txt'
            }
          ]
        }
      ]
    })
  })

  it('serializes a session into the per-session persistence shape', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Save this',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })

    const persisted = toPersistedSession(useSessionStore.getState().sessions[0])

    expect(persisted).toMatchObject({
      id: 'transport-session-1',
      projectId: 'project-a',
      cwd: '/workspace/project',
      messages: [
        {
          content: 'Save this'
        }
      ]
    })
    expect(persisted).not.toHaveProperty('isPending')
  })

  it('stores and persists the conversation approval profile', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Run this',
      cwd: '/workspace/project',
      projectId: 'project-a',
      permissionProfile: 'auto'
    })

    expect(useSessionStore.getState().sessions[0].permissionProfile).toBe('auto')

    useSessionStore.getState().setPermissionProfile('transport-session-1', 'full')

    expect(toPersistedSession(useSessionStore.getState().sessions[0]).permissionProfile).toBe(
      'full'
    )
  })

  it('marks unbound pending sessions so persistence can skip them', () => {
    useSessionStore.getState().appendPendingUserMessage({
      content: 'Save after ACP creates the session',
      cwd: '/workspace/project'
    })

    // The persistence bridge relies on isPending to keep unbound sessions off disk.
    expect(useSessionStore.getState().sessions[0].isPending).toBe(true)
  })

  it('stamps a new session with the provided project id', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Scope me',
      cwd: '/workspace/project',
      projectId: 'project-abc'
    })

    expect(useSessionStore.getState().sessions[0].projectId).toBe('project-abc')
    expect(toPersistedSession(useSessionStore.getState().sessions[0]).projectId).toBe('project-abc')
  })

  it('persists a bound pending session with the runtime session id only', () => {
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: 'Save after ACP creates the session',
      cwd: '/workspace/project',
      projectId: 'project-abc'
    })

    useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending?.sessionId ?? '',
      sessionId: 'transport-session-1',
      cwd: '/workspace/project'
    })

    const boundSession = useSessionStore.getState().sessions[0]

    expect(boundSession.isPending).toBe(false)

    const persisted = toPersistedSession(boundSession)

    expect(persisted).toMatchObject({
      id: 'transport-session-1',
      projectId: 'project-abc',
      cwd: '/workspace/project',
      messages: [
        {
          id: pending?.messageId,
          content: 'Save after ACP creates the session'
        }
      ]
    })
    expect(persisted).not.toHaveProperty('isPending')
  })

  describe('interrupted session resume', () => {
    const hydrateInterrupted = (overrides: Partial<PersistedChatSession> = {}): void => {
      useSessionStore.getState().hydrateSessions(
        [
          {
            id: 'resumable-session',
            projectId: 'default',
            title: 'Interrupted',
            cwd: '/workspace',
            status: 'error',
            error: INTERRUPTED_SESSION_ERROR,
            messages: [],
            createdAt: 1,
            updatedAt: 2,
            ...overrides
          }
        ],
        { version: SESSION_MANIFEST_VERSION, lastSessionId: 'resumable-session' }
      )
    }

    it('flags a restored interrupted session so the UI can offer resume', () => {
      hydrateInterrupted()

      expect(useSessionStore.getState().sessions[0].interrupted).toBe(true)
    })

    it('leaves the flag unset when the error is not the interrupted marker', () => {
      hydrateInterrupted({ error: 'Something else failed' })

      expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
    })

    it('never persists the transient interrupted flag', () => {
      hydrateInterrupted()

      const persisted = toPersistedSession(useSessionStore.getState().sessions[0])

      expect(persisted).not.toHaveProperty('interrupted')
    })

    it('markResumed clears the interrupted state so the composer is usable', () => {
      hydrateInterrupted()

      useSessionStore.getState().markResumed('resumable-session')
      const session = useSessionStore.getState().sessions[0]

      expect(session.interrupted).toBeUndefined()
      expect(session.error).toBeUndefined()
      expect(session.status).toBe('idle')
    })
  })
})
