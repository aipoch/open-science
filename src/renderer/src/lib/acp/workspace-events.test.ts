import type { AcpRuntimeEvent, AcpPermissionRequest } from '../../../../shared/acp'
import type { ArtifactFile } from '../../../../shared/artifacts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import {
  applyWorkspaceRuntimeEvent,
  assembleReviewRunRequest,
  syncWorkspacePermissionState,
  suppressNextAutoReview,
  clearSuppressNextAutoReview
} from './workspace-events'

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

  it('enters the compacting state (not a dead-end error) for a recoverable overflow event', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'compare these screenshots'
    })

    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-overflow',
        kind: 'error',
        level: 'error',
        recoverable: 'context-overflow',
        title: 'Prompt failed',
        text: 'Internal error: Request too large (max 32MB).'
      })
    )

    expect(applied).toBe(true)
    const session = useSessionStore.getState().sessions[0]
    expect(session.compacting).toBe(true)
    expect(session.status).not.toBe('error')
    // The raw overflow message is not surfaced as a session error; the UI shows a neutral note instead.
    expect(session.error).toBeUndefined()
  })

  it('surfaces a session-scoped agent warning as the waiting-indicator status, cleared on stop', async () => {
    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'event-1', kind: 'system', level: 'warning', text: 'retrying request…' })
    )

    expect(applied).toBe(true)
    expect(useSessionStore.getState().sessions[0].agentStatus).toBe('retrying request…')

    // The run finishing clears the transient status so it never lingers into the next turn.
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'event-2', kind: 'stop', text: 'end_turn' }))
    expect(useSessionStore.getState().sessions[0].agentStatus).toBeUndefined()
  })

  it('ignores an info-level system event (only warnings become status)', async () => {
    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'event-1', kind: 'system', level: 'info', text: 'Session created' })
    )

    expect(applied).toBe(false)
    expect(useSessionStore.getState().sessions[0].agentStatus).toBeUndefined()
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

  it('auto-opens a generated molecule artifact in the preview panel', async () => {
    const finalizedArtifact = createArtifactFile({
      id: 'transport-session-1:message-1:aspirin.mol',
      sessionId: 'transport-session-1',
      messageId: 'message-1',
      runId: undefined,
      name: 'aspirin.mol',
      path: '/Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/aspirin.mol',
      fileUrl:
        'file:///Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/aspirin.mol'
    })
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([finalizedArtifact])

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-1',
        kind: 'artifact',
        runId: 'run-1',
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-1',
        artifacts: [createArtifactFile({ name: 'aspirin.mol' })]
      }),
      { finalizeRunArtifacts }
    )

    const preview = usePreviewWorkbenchStore.getState()

    expect(preview.panelState).toBe('open')
    expect(preview.activeItemId).toBe('transport-session-1:message-1:aspirin.mol')
    expect(preview.items).toEqual([
      expect.objectContaining({
        id: 'transport-session-1:message-1:aspirin.mol',
        type: 'file',
        format: 'molecule',
        name: 'aspirin.mol'
      })
    ])
  })

  it('does not auto-open non-molecule artifacts', async () => {
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

    await applyWorkspaceRuntimeEvent(
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

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: undefined,
      panelState: 'collapsed',
      items: []
    })
  })

  describe('auto-review gate on stop event', () => {
    it('triggers a review via window.api.reviewer.run when autoReviewEnabled is true', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      vi.stubGlobal('window', { api: { reviewer: { run: reviewerRun } } })

      // Auto-review defaults off, so it must be explicitly enabled for this session.
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)

      // Add an agent message so triggerAutoReview finds a turnMessageId.
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

      // Give the fire-and-forget promise time to settle.
      await Promise.resolve()
      await Promise.resolve()

      expect(reviewerRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'transport-session-1' })
      )

      vi.unstubAllGlobals()
    })

    it('does not trigger a review when autoReviewEnabled is false', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      vi.stubGlobal('window', { api: { reviewer: { run: reviewerRun } } })

      // Disable auto-review on this session.
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', false)

      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

      await Promise.resolve()
      await Promise.resolve()

      expect(reviewerRun).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('does not trigger a review by default when autoReviewEnabled was never set', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      vi.stubGlobal('window', { api: { reviewer: { run: reviewerRun } } })

      // No setAutoReviewEnabled call: the session keeps its default (off).
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

      await Promise.resolve()
      await Promise.resolve()

      expect(reviewerRun).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('re-enables a review after toggling autoReviewEnabled back to true', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      vi.stubGlobal('window', { api: { reviewer: { run: reviewerRun } } })

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', false)
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)

      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

      await Promise.resolve()
      await Promise.resolve()

      expect(reviewerRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'transport-session-1' })
      )

      vi.unstubAllGlobals()
    })
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

describe('loop guard: suppressNextAutoReview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Run the analysis'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'stream-1',
      eventId: 'event-agent-1',
      content: 'Analysis complete'
    })
    // These tests exercise the suppression guard, not the default; auto-review defaults off, so
    // enable it up front to isolate the loop-guard behavior.
    useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
  })

  it('suppresses triggerAutoReview for exactly one stop, then resumes normal behavior', async () => {
    const reviewerRun = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { reviewer: { run: reviewerRun } } })

    // Mark the next stop for suppression (simulates the [Auditor] correction turn).
    suppressNextAutoReview('transport-session-1')

    // First stop: suppressed (correction turn's stop).
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-correction', kind: 'stop', sessionId: 'transport-session-1' })
    )
    await Promise.resolve()
    await Promise.resolve()

    // reviewer.run must NOT have been called for the suppressed stop.
    expect(reviewerRun).not.toHaveBeenCalled()

    // Append another agent message so the next triggerAutoReview finds a turnMessageId.
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'stream-2',
      eventId: 'event-agent-2',
      content: 'Follow-up response'
    })

    // Second stop: normal turn — must NOT be suppressed.
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-normal', kind: 'stop', sessionId: 'transport-session-1' })
    )
    await Promise.resolve()
    await Promise.resolve()

    // reviewer.run called exactly once for the normal turn.
    expect(reviewerRun).toHaveBeenCalledTimes(1)
    expect(reviewerRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'transport-session-1' })
    )

    vi.unstubAllGlobals()
  })

  it('does not suppress a different session', async () => {
    const reviewerRun = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { reviewer: { run: reviewerRun } } })

    // Suppress only 'other-session'.
    suppressNextAutoReview('other-session')

    // A stop for 'transport-session-1' should still trigger auto-review.
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-1', kind: 'stop', sessionId: 'transport-session-1' })
    )
    await Promise.resolve()
    await Promise.resolve()

    // transport-session-1 is not suppressed, reviewer.run fires.
    expect(reviewerRun).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })

  it('clearSuppressNextAutoReview cancels a pending suppression (correction turn failed to send)', async () => {
    const reviewerRun = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { reviewer: { run: reviewerRun } } })

    // A correction was about to fire (suppress set), but its sendPrompt failed — clear the flag so
    // the user's next real turn is not silently skipped.
    suppressNextAutoReview('transport-session-1')
    clearSuppressNextAutoReview('transport-session-1')

    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-next', kind: 'stop', sessionId: 'transport-session-1' })
    )
    await Promise.resolve()
    await Promise.resolve()

    // The suppression was cleared, so the next turn's review fires normally.
    expect(reviewerRun).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })
})

describe('assembleReviewRunRequest — shared turn selection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T08:00:00.000Z'))
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Analyze the data'
    })
  })

  it('returns undefined when the session has no completed agent turn', () => {
    const result = assembleReviewRunRequest('transport-session-1')
    expect(result).toBeUndefined()
  })

  it('returns undefined when the session does not exist', () => {
    const result = assembleReviewRunRequest('nonexistent-session')
    expect(result).toBeUndefined()
  })

  it('selects the last agent message as turnMessageId', () => {
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'stream-1',
      eventId: 'event-agent-1',
      content: 'Analysis complete'
    })

    const result = assembleReviewRunRequest('transport-session-1')
    const session = useSessionStore.getState().sessions[0]
    const lastAgent = [...session.messages].reverse().find((m) => m.role === 'agent')

    expect(result).not.toBeUndefined()
    expect(result!.sessionId).toBe('transport-session-1')
    expect(result!.turnMessageId).toBe(lastAgent!.id)
    expect(result!.mainSessionId).toBe('transport-session-1')
  })

  it('skips autoReviewEnabled — returns a request even when auto-review is off', () => {
    useSessionStore.getState().setAutoReviewEnabled('transport-session-1', false)
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'stream-1',
      eventId: 'event-agent-1',
      content: 'Done'
    })

    const result = assembleReviewRunRequest('transport-session-1')

    // assembleReviewRunRequest does not check autoReviewEnabled — manual path ignores the toggle.
    expect(result).not.toBeUndefined()
  })

  it('picks the most recent of multiple agent turns', () => {
    // First turn
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'stream-1',
      eventId: 'event-1',
      content: 'First response'
    })
    // Second user message
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Follow-up'
    })
    // Second agent turn
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'stream-2',
      eventId: 'event-2',
      content: 'Second response'
    })

    const result = assembleReviewRunRequest('transport-session-1')
    const session = useSessionStore.getState().sessions[0]
    const lastAgent = [...session.messages].reverse().find((m) => m.role === 'agent')

    expect(result!.turnMessageId).toBe(lastAgent!.id)
  })
})
