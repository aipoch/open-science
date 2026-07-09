import type { AcpRuntimeEvent, AcpPermissionRequest } from '../../../../shared/acp'
import type { ArtifactFile } from '../../../../shared/artifacts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { applyWorkspaceRuntimeEvent, syncWorkspacePermissionState } from './workspace-events'

// Creates a runtime event with stable defaults for store adapter tests.
const createEvent = (overrides: Partial<AcpRuntimeEvent>): AcpRuntimeEvent => ({
  id: 'event-1',
  timestamp: 1710000000000,
  kind: 'message',
  level: 'info',
  sessionId: 'transport-session-1',
  ...overrides
})

// Creates a pending permission request tied to the default test session.
const createPermissionRequest = (
  overrides: Partial<AcpPermissionRequest> = {}
): AcpPermissionRequest => ({
  requestId: 'permission-1',
  sessionId: 'transport-session-1',
  toolCallId: 'tool-1',
  title: 'Allow edit?',
  options: [],
  raw: {},
  ...overrides
})

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

describe('workspace runtime events', () => {
  // Rebuild the visible session before each adapter assertion.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Summarize this'
    })
  })

  it('applies assistant message events as streamed agent chunks', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-1',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'Hel'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-2',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'lo'
      })
    )

    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      role: 'agent',
      content: 'Hello',
      streamId: 'assistant-message-1',
      eventIds: ['event-1', 'event-2'],
      status: 'streaming'
    })
  })

  it('finishes and fails runs from stop and error events', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-1',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'Done'
      })
    )
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'event-2', kind: 'stop', text: 'end_turn' }))

    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
    expect(useSessionStore.getState().sessions[0].messages[1].status).toBe('complete')

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Try again'
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-3',
        kind: 'error',
        title: 'Prompt failed',
        text: 'Network failed'
      })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Network failed'
    })
  })

  it('syncs permission waiting state from current pending requests', () => {
    syncWorkspacePermissionState([createPermissionRequest()])

    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-permission')

    syncWorkspacePermissionState([])

    expect(useSessionStore.getState().sessions[0].status).toBe('running')
  })

  it('does not route tool events into preview state', async () => {
    const wasApplied = await applyWorkspaceRuntimeEvent({
      ...createEvent({
        kind: 'tool',
        toolCallId: 'tool-1',
        title: 'Read file',
        providerToolName: 'jupyter',
        status: 'pending'
      }),
      mcpServerId: 'python',
      previewToolKind: 'mcp-component'
    } as AcpRuntimeEvent)

    expect(wasApplied).toBe(true)
    expect(useSessionStore.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        id: 'tool-1',
        kind: 'tool',
        title: 'Read file',
        providerToolName: 'jupyter',
        status: 'pending'
      })
    ])
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: undefined,
      panelState: 'collapsed',
      openRequestVersion: 0,
      items: []
    })
  })

  it('does not route follow-up tool updates into preview state', async () => {
    const wasApplied = await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-1',
        kind: 'tool',
        toolCallId: 'tool-web-1',
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
    )

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-2',
        kind: 'tool',
        toolCallId: 'tool-web-1',
        status: 'completed'
      })
    )

    expect(wasApplied).toBe(true)
    expect(useSessionStore.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        id: 'tool-web-1',
        kind: 'tool',
        toolKind: 'fetch',
        providerToolName: 'WebSearch',
        title: '"open science repositories"',
        status: 'completed',
        eventIds: ['event-1', 'event-2'],
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
    ])
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: undefined,
      panelState: 'collapsed',
      openRequestVersion: 0,
      items: []
    })
  })

  it('attaches artifact events to the current message and finalizes their file paths', async () => {
    const finalizedArtifact = createArtifactFile({
      id: 'transport-session-1:message-1:result.txt',
      sessionId: 'transport-session-1',
      messageId: 'message-1',
      runId: undefined,
      path: '/Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt',
      fileUrl:
        'file:///Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt'
    })
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([finalizedArtifact])

    const wasApplied = await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-1',
        kind: 'artifact',
        runId: 'run-1',
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-1',
        artifacts: [createArtifactFile()]
      }),
      { finalizeRunArtifacts }
    )

    const session = useSessionStore.getState().sessions[0]
    const message = session.messages[1]

    expect(wasApplied).toBe(true)
    expect(finalizeRunArtifacts).toHaveBeenCalledWith({
      claimId: 'claim-1',
      messageId: message.id
    })
    expect(message).toMatchObject({
      role: 'agent',
      content: '',
      artifactIds: ['transport-session-1:message-1:result.txt']
    })
    expect(session.artifacts).toEqual([
      expect.objectContaining({
        id: 'transport-session-1:message-1:result.txt',
        path: expect.stringContaining('/transport-session-1/message-1/result.txt')
      })
    ])
  })

  it('records finalize failures and retries when an artifact event is replayed', async () => {
    const finalizedArtifact = createArtifactFile({
      id: 'transport-session-1:message-1:result.txt',
      sessionId: 'transport-session-1',
      messageId: 'message-1',
      runId: undefined,
      path: '/Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt',
      fileUrl:
        'file:///Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt'
    })
    const finalizeRunArtifacts = vi
      .fn()
      .mockRejectedValueOnce(new Error('move failed'))
      .mockResolvedValueOnce([finalizedArtifact])
    const artifactEvent = createEvent({
      id: 'artifact-event-1',
      kind: 'artifact',
      runId: 'run-1',
      artifactSessionId: 'artifact-session-1',
      artifactClaimId: 'claim-1',
      artifacts: [createArtifactFile()]
    })

    await expect(
      applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts })
    ).rejects.toThrow('move failed')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Generated file finalization failed')
    })

    await applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts })

    const session = useSessionStore.getState().sessions[0]

    expect(finalizeRunArtifacts).toHaveBeenCalledTimes(2)
    expect(session.messages).toHaveLength(2)
    expect(session.messages[1].artifactIds).toEqual(['transport-session-1:message-1:result.txt'])
    expect(session.error).toBeUndefined()
  })
})
