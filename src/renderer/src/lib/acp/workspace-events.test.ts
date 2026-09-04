import {
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  type AcpRuntimeEvent,
  type AcpPermissionRequest
} from '../../../../shared/acp'
import {
  ARTIFACT_FINALIZATION_INVALID_PROOF,
  ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
  type ArtifactFile
} from '../../../../shared/artifacts'
import { SessionRevisionConflictError } from '../../../../shared/session-persistence'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import { useNavigationStore } from '../../stores/navigation-store'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import { saveSessionInOrder } from '../session-persistence/session-persistence'
import {
  applyWorkspaceRuntimeEvent,
  assembleReviewRunRequest,
  resumeAutoReviewsAfterQuitAbort,
  suppressAutoReviewsForQuit,
  suppressNextAutoReview,
  clearSuppressNextAutoReview,
  resetDeferredArtifactEventsForTests
} from './workspace-events'
import {
  resetWorkspaceRuntimeEventOwnerForTests,
  syncWorkspaceAgentFirstOutputState,
  syncWorkspacePermissionState
} from './workspace-runtime-event-owner'

// Creates a runtime event with stable defaults for store adapter tests.
// Runtime boundary tests deliberately feed incomplete provider/IPC events through defensive guards.
const createEvent = (overrides: Partial<AcpRuntimeEvent>): AcpRuntimeEvent =>
  ({
    id: 'event-1',
    timestamp: 1710000000000,
    kind: 'message',
    level: 'info',
    sessionId: 'transport-session-1',
    ...overrides
  }) as unknown as AcpRuntimeEvent

type SessionSaveBoundary = (
  session: Parameters<typeof saveSessionInOrder>[0]
) => Promise<Parameters<typeof saveSessionInOrder>[0] | void>

const stubReviewerApi = (
  reviewerRun: ReturnType<typeof vi.fn>,
  saveSession: SessionSaveBoundary = async (session) => session
): void => {
  vi.stubGlobal('window', { api: { reviewer: { run: reviewerRun }, sessions: { saveSession } } })
}

// Creates a pending permission request tied to the default test session.
const createPermissionRequest = (
  overrides: Partial<AcpPermissionRequest> = {}
): AcpPermissionRequest => ({
  requestId: 'permission-1',
  sessionId: 'transport-session-1',
  toolCallId: 'tool-1',
  title: 'Allow edit?',
  options: [],
  ...overrides
})

const createArtifactFile = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
  id: 'artifact-session-1:run-1:result.txt',
  projectId: 'default-project',
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

const pendingPlanProjection: ActivePlanProjection = {
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 1,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Review the generated plan',
    phases: [],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'Ready for review.' }
  },
  stepStatuses: {},
  stepStates: {},
  counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
}

describe('workspace runtime events', () => {
  // Rebuild the visible session before each adapter assertion.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    resetDeferredArtifactEventsForTests()
    resetWorkspaceRuntimeEventOwnerForTests()
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Summarize this',
      projectId: 'default-project'
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

  it('keeps CodeBuddy assistant segments on each side of later tool calls', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        agentFrameworkId: 'codebuddy'
      }))
    }))
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'codebuddy-prose',
        timestamp: Date.now(),
        role: 'assistant',
        messageId: 'codebuddy-provider-message',
        promptMessageId,
        text: 'I will search the selected source.'
      })
    )
    vi.advanceTimersByTime(1)
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'codebuddy-tool-1',
        timestamp: Date.now(),
        kind: 'tool',
        toolCallId: 'codebuddy-notebook-state',
        providerToolName: 'open-science-notebook/notebook_state',
        promptMessageId,
        status: 'in_progress'
      })
    )
    vi.advanceTimersByTime(1)
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'codebuddy-tool-2',
        timestamp: Date.now(),
        kind: 'tool',
        toolCallId: 'codebuddy-write-artifact',
        providerToolName: 'open-science-artifacts/write_artifact_file',
        promptMessageId,
        status: 'in_progress'
      })
    )
    vi.advanceTimersByTime(1)
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'codebuddy-final-prose',
        timestamp: Date.now(),
        role: 'assistant',
        messageId: 'codebuddy-provider-message:codebuddy-write-artifact',
        promptMessageId,
        text: 'The search results are ready.'
      })
    )

    const session = useSessionStore.getState().sessions[0]
    const messages = session.messages.filter((item) => item.role === 'agent')
    expect(session.activities).toHaveLength(2)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.sortIndex).toBeLessThan(session.activities?.[0]?.sortIndex ?? 0)
    expect(
      session.activities?.every((activity) => activity.sortIndex < (messages[1]?.sortIndex ?? 0))
    ).toBe(true)
  })

  it('keeps a pending Plan actionable after the runtime reports a timeout stop', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'plan-ready', kind: 'plan', planProjection: pendingPlanProjection })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'plan-timeout', kind: 'stop', text: 'end_turn' })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-plan-approval',
      activeRun: undefined,
      activePlanProjection: { approval: 'pending', lifecycle: 'awaiting_approval' }
    })
  })

  it('projects Plan feedback runtime events as settled user Messages', async () => {
    const sessionBefore = useSessionStore.getState().sessions[0]
    useSessionStore.setState({
      sessions: [
        {
          ...sessionBefore,
          status: 'waiting-plan-approval',
          activeRun: { promptMessageId: 'prompt-1', startedAt: 1 }
        }
      ]
    })

    await expect(
      applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'session-user-message-message-1',
          role: 'user',
          messageId: 'message-1',
          text: 'Split the analysis by cohort.'
        })
      )
    ).resolves.toBe(true)

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('running')
    expect(session.messages.at(-1)).toMatchObject({
      id: 'message-1',
      role: 'user',
      content: 'Split the analysis by cohort.',
      status: 'complete'
    })
  })

  it('projects trusted Reviewer Correction attribution onto the routed Message', async () => {
    const originalSession = useSessionStore.getState().sessions[0]
    const originalPromptMessageId = originalSession.messages[0]!.id
    useSessionStore.setState({
      sessions: [{ ...originalSession, status: 'idle', activeRun: undefined }]
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'reviewer-correction-event-1',
        role: 'user',
        messageId: 'reviewer-correction-1',
        promptMessageId: 'reviewer-correction-1',
        text: '[Auditor] Correct the unsupported claim.',
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review-1'
        }
      })
    )

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'reviewer-correction-response-event-1',
        role: 'assistant',
        messageId: 'reviewer-correction-response-1',
        promptMessageId: 'reviewer-correction-1',
        text: 'Corrected the unsupported claim.'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'reviewer-correction-stop-1',
        kind: 'stop',
        promptMessageId: 'reviewer-correction-1',
        text: 'end_turn'
      })
    )

    const storedSession = useSessionStore.getState().sessions[0]
    expect(
      storedSession.messages.find((message) => message.id === 'reviewer-correction-1')
    ).toMatchObject({
      id: 'reviewer-correction-1',
      role: 'user',
      attribution: {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-1'
      }
    })
    expect(originalPromptMessageId).not.toBe('reviewer-correction-1')
    const correctionResponse = storedSession.messages.find(
      (message) =>
        message.role === 'agent' && message.responseToMessageId === 'reviewer-correction-1'
    )
    expect(correctionResponse).toMatchObject({
      role: 'agent',
      status: 'complete',
      responseToMessageId: 'reviewer-correction-1'
    })
    expect(
      storedSession.conversationGraph?.messages.find(
        (message) => message.id === correctionResponse?.id
      )
    ).toMatchObject({ status: 'complete', responseToMessageId: 'reviewer-correction-1' })
  })

  it('consumes activity-group declarations without creating a visible tool step', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'group-event-1',
        kind: 'tool',
        toolCallId: 'group-call-1',
        providerToolName: 'mcp__open-science-activity__begin_activity_group',
        rawInput: { title: 'Inspect the implementation' },
        status: 'pending'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'narration-event-1',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'I will inspect the implementation first.'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'group-event-2',
        kind: 'tool',
        toolCallId: 'group-call-1',
        status: 'completed'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'tool-event-1',
        kind: 'tool',
        toolCallId: 'tool-read-1',
        providerToolName: 'Read',
        toolKind: 'read',
        status: 'completed'
      })
    )

    const session = useSessionStore.getState().sessions[0]
    expect(session.activities).toEqual([
      expect.objectContaining({ id: 'tool-read-1', activityGroupId: 'group-call-1' })
    ])
    expect(session.activityGroups).toEqual([
      expect.objectContaining({
        id: 'group-call-1',
        title: 'Inspect the implementation',
        activityIds: ['tool-read-1']
      })
    ])
  })

  it('projects Notebook authorization and declined permission metadata', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'tool-prepared',
        kind: 'tool',
        toolCallId: 'tool-approved',
        providerToolName: 'mcp__open-science-notebook__notebook_execute',
        status: 'in_progress'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'tool-authorized',
        kind: 'tool',
        toolCallId: 'tool-approved',
        status: 'in_progress',
        executionInvocationId: 'invocation-1'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'tool-declined',
        kind: 'tool',
        toolCallId: 'tool-declined',
        providerToolName: 'mcp__open-science-notebook__notebook_execute',
        status: 'completed',
        toolDisposition: 'declined'
      })
    )

    expect(useSessionStore.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        id: 'tool-approved',
        executionInvocationId: 'invocation-1',
        eventIds: ['tool-prepared', 'tool-authorized']
      }),
      expect.objectContaining({ id: 'tool-declined', toolDisposition: 'declined' })
    ])
  })

  it('applies assistant image events without creating placeholder text', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-image',
        role: 'assistant',
        messageId: 'assistant-message-1',
        image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
      })
    )

    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      role: 'agent',
      content: '',
      images: [{ id: 'event-image', mimeType: 'image/png', data: 'AQID', byteLength: 3 }]
    })
  })

  it('restores image data from the existing runtime raw projection and removes its sentinel', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-image',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: '[open-science:acp-message-image]',
        raw: {
          update: {
            content: {
              type: 'image',
              mimeType: 'image/png',
              data: 'AQID',
              byteLength: 3
            }
          }
        }
      })
    )

    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      content: '',
      images: [{ id: 'event-image', mimeType: 'image/png', data: 'AQID', byteLength: 3 }]
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
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-2',
        kind: 'stop',
        text: 'end_turn',
        turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 2 },
        modelCallUsage: [
          {
            id: 'prompt-message:model-call:0',
            index: 0,
            sourceInvocationId: 'provider-call-1',
            inputTokens: 19,
            cacheTokens: 8,
            outputTokens: 5,
            contextUsedTokens: 27,
            contextWindowSize: 128_000
          },
          {
            id: 'prompt-message:model-call:1',
            index: 1,
            sourceInvocationId: 'provider-call-2',
            inputTokens: 12,
            cacheTokens: 7,
            outputTokens: 9,
            contextUsedTokens: 19,
            contextWindowSize: 128_000
          }
        ]
      })
    )

    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      status: 'complete',
      turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 2 },
      modelCallUsage: [
        expect.objectContaining({ id: 'prompt-message:model-call:0', index: 0 }),
        expect.objectContaining({ id: 'prompt-message:model-call:1', index: 1 })
      ]
    })

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
    // An opaque ACP-layer failure (no providerError tag, not app-crafted) stays reportable: the event
    // path defers to the text tier rather than suppressing the button.
    expect(useSessionStore.getState().sessions[0].errorReportable).toBe(true)
  })

  it('retains a cancelled prompt as an interrupted turn instead of completing it', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-1',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'I will search PubMed now.'
      })
    )

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-2',
        kind: 'stop',
        text: 'cancelled',
        turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 2 },
        modelCallUsage: [
          {
            id: 'prompt-message:model-call:0',
            index: 0,
            inputTokens: 19,
            cacheTokens: 8,
            outputTokens: 5
          },
          {
            id: 'prompt-message:model-call:1',
            index: 1,
            inputTokens: 12,
            cacheTokens: 7,
            outputTokens: 9
          }
        ]
      })
    )

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('error')
    expect(session.activeRun).toBeUndefined()
    expect(session.resumeRecovery).toMatchObject({
      kind: 'resume-required',
      cause: 'cancelled',
      promptMessageId
    })
    expect(session.messages[0]).toMatchObject({ id: promptMessageId, interrupted: true })
    expect(session.messages[1]).toMatchObject({
      content: 'I will search PubMed now.',
      status: 'error',
      turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 2 },
      modelCallUsage: [
        expect.objectContaining({ id: 'prompt-message:model-call:0', index: 0 }),
        expect.objectContaining({ id: 'prompt-message:model-call:1', index: 1 })
      ]
    })
    expect(toPersistedSession(session).messages[1]).toMatchObject({
      turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 2 },
      modelCallUsage: [
        expect.objectContaining({ id: 'prompt-message:model-call:0', index: 0 }),
        expect.objectContaining({ id: 'prompt-message:model-call:1', index: 1 })
      ]
    })
    expect(session.messages[1].completedAt).toBeUndefined()
  })

  it('keeps both cancelled and resumed-completed context points on the owning prompt', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    if (!promptMessageId) throw new Error('expected active prompt')

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'usage-cancelled',
        timestamp: 100,
        kind: 'stop',
        text: 'cancelled',
        promptMessageId,
        terminalContextWindow: {
          termination: { kind: 'stop', stopReason: 'cancelled' },
          contextWindow: { used: 31_000, size: 128_000 },
          source: 'provider-update'
        }
      })
    )

    useSessionStore
      .getState()
      .prepareInterruptedTurnContinuation('transport-session-1', promptMessageId, undefined, false)
    useSessionStore.getState().completeInterruptedTurnResume('transport-session-1')

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'usage-completed',
        timestamp: 200,
        kind: 'stop',
        text: 'end_turn',
        promptMessageId,
        terminalContextWindow: {
          termination: { kind: 'stop', stopReason: 'end_turn' },
          contextWindow: { used: 34_000, size: 128_000 },
          modelStepUsage: { inputTokens: 2_000, cacheTokens: 32_000, outputTokens: 100 },
          source: 'provider-response'
        }
      })
    )

    const session = useSessionStore.getState().sessions[0]
    const samples = session.messages[0].contextWindowSamples
    expect(samples).toEqual([
      expect.objectContaining({
        id: 'usage-cancelled',
        timestamp: 100,
        termination: { kind: 'stop', stopReason: 'cancelled' },
        contextWindow: { used: 31_000, size: 128_000 },
        runtimeSegmentId: expect.any(String)
      }),
      expect.objectContaining({
        id: 'usage-completed',
        timestamp: 200,
        termination: { kind: 'stop', stopReason: 'end_turn' },
        contextWindow: { used: 34_000, size: 128_000 },
        runtimeSegmentId: expect.any(String)
      })
    ])
    expect(
      session.conversationGraph?.messages.find((message) => message.id === promptMessageId)
        ?.contextWindowSamples
    ).toEqual(samples)
    expect(toPersistedSession(session).messages[0].contextWindowSamples).toEqual(samples)
  })

  it('records a terminal error context point on the active prompt', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'usage-error',
        timestamp: 300,
        kind: 'error',
        title: 'Prompt failed',
        text: 'Network failed',
        terminalContextWindow: {
          termination: { kind: 'error' },
          contextWindow: { used: 18_000, size: 128_000 },
          source: 'local-estimate'
        }
      })
    )

    expect(useSessionStore.getState().sessions[0].messages[0]).toMatchObject({
      id: promptMessageId,
      contextWindowSamples: [
        expect.objectContaining({
          id: 'usage-error',
          termination: { kind: 'error' },
          contextWindow: { used: 18_000, size: 128_000 }
        })
      ]
    })
  })

  it('binds a cancelled app continuation to its originating prompt', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].messages[0].id
    useSessionStore.getState().finishRun('transport-session-1')

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-1',
        kind: 'stop',
        text: 'cancelled',
        promptMessageId
      })
    )

    const session = useSessionStore.getState().sessions[0]
    expect(session.resumeRecovery).toMatchObject({
      kind: 'resume-required',
      cause: 'cancelled',
      promptMessageId
    })
    expect(session.messages[0]).toMatchObject({ id: promptMessageId, interrupted: true })
  })

  it('reattaches a post-stop app continuation and its activity and usage to the originating turn', async () => {
    const originMessageId = useSessionStore.getState().sessions[0].messages[0].id
    useSessionStore.getState().finishRun('transport-session-1')
    expect(useSessionStore.getState().sessions[0].activeRun).toBeUndefined()

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'continuation-group',
        kind: 'tool',
        promptMessageId: originMessageId,
        toolCallId: 'continuation-group',
        providerToolName: 'mcp__open-science-activity__begin_activity_group',
        rawInput: { title: 'Continue after handoff' },
        status: 'pending'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'continuation-tool',
        kind: 'tool',
        promptMessageId: originMessageId,
        toolCallId: 'continuation-tool',
        providerToolName: 'Read',
        toolKind: 'read',
        status: 'completed'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'continuation-message',
        role: 'assistant',
        messageId: 'continuation-stream',
        promptMessageId: originMessageId,
        text: 'The handoff analysis is complete.'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'continuation-stop',
        kind: 'stop',
        promptMessageId: originMessageId,
        text: 'end_turn',
        turnUsage: { inputTokens: 31, cacheTokens: 10, outputTokens: 7 }
      })
    )

    const session = useSessionStore.getState().sessions[0]
    expect(session.messages.at(-1)).toMatchObject({
      role: 'agent',
      content: 'The handoff analysis is complete.',
      responseToMessageId: originMessageId,
      status: 'complete',
      turnUsage: { inputTokens: 31, cacheTokens: 10, outputTokens: 7 }
    })
    expect(session.activities).toEqual([
      expect.objectContaining({
        id: 'continuation-tool',
        promptMessageId: originMessageId,
        activityGroupId: 'continuation-group'
      })
    ])
    expect(session.conversationGraph?.activities).toEqual([
      expect.objectContaining({
        id: 'continuation-tool',
        promptMessageId: originMessageId
      })
    ])
  })

  it('tracks native context compaction without adding chat messages', async () => {
    useSessionStore.getState().finishRun('transport-session-1')
    const sessionBefore = useSessionStore.getState().sessions[0]
    const messageCount = sessionBefore.messages.length
    const promptMessageId = sessionBefore.messages[0].id

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'compact-start',
        kind: 'compaction',
        promptMessageId,
        status: 'in_progress',
        title: 'Compacting context',
        toolCallId: 'context-compaction:1'
      })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      compacting: true,
      activities: [
        expect.objectContaining({
          id: 'context-compaction:1',
          promptMessageId,
          providerToolName: 'ContextCompaction',
          status: 'in_progress',
          title: 'Compacting context'
        })
      ]
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'compact-done',
        kind: 'compaction',
        promptMessageId,
        status: 'completed',
        title: 'Context compacted',
        toolCallId: 'context-compaction:1'
      })
    )

    const session = useSessionStore.getState().sessions[0]
    expect(session.compacting).toBeUndefined()
    expect(session.status).toBe('idle')
    expect(session.messages).toHaveLength(messageCount)
    expect(session.activities).toEqual([
      expect.objectContaining({
        id: 'context-compaction:1',
        eventIds: ['compact-start', 'compact-done'],
        promptMessageId,
        providerToolName: 'ContextCompaction',
        status: 'completed',
        title: 'Context compacted'
      })
    ])
    expect(toPersistedSession(session).conversationGraph?.activities).toEqual([
      expect.objectContaining({
        id: 'context-compaction:1',
        promptMessageId,
        providerToolName: 'ContextCompaction',
        status: 'completed'
      })
    ])

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'compact-late-start',
        kind: 'compaction',
        promptMessageId,
        status: 'in_progress',
        title: 'Compacting context',
        toolCallId: 'context-compaction:1'
      })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      compacting: undefined,
      activities: [
        expect.objectContaining({
          eventIds: ['compact-start', 'compact-done'],
          status: 'completed',
          title: 'Context compacted'
        })
      ]
    })
  })

  it('settles cancelled native compaction without surfacing a session error', async () => {
    useSessionStore.getState().finishRun('transport-session-1')
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'compact-start',
        kind: 'compaction',
        status: 'in_progress',
        title: 'Compacting context',
        toolCallId: 'context-compaction:cancelled'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'compact-cancelled',
        kind: 'compaction',
        status: 'cancelled',
        title: 'Context compaction cancelled',
        toolCallId: 'context-compaction:cancelled'
      })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      compacting: undefined,
      error: undefined,
      activities: [
        expect.objectContaining({
          status: 'completed',
          title: 'Context compaction cancelled'
        })
      ]
    })
  })

  it('surfaces native compaction failures as non-reportable session errors', async () => {
    useSessionStore.getState().finishRun('transport-session-1')
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'compact-start',
        kind: 'compaction',
        status: 'in_progress',
        title: 'Compacting context',
        toolCallId: 'context-compaction:failed'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'compact-failed',
        kind: 'compaction',
        status: 'failed',
        title: 'Context compaction failed',
        toolCallId: 'context-compaction:failed',
        text: 'Agent rejected /compact'
      })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      compacting: undefined,
      error: 'Agent rejected /compact',
      errorReportable: false,
      activities: [
        expect.objectContaining({ status: 'failed', title: 'Context compaction failed' })
      ]
    })
  })

  it('ignores stale compaction events after a newer retry owns the session', async () => {
    useSessionStore.getState().finishRun('transport-session-1')
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'compact-start', kind: 'compaction', status: 'in_progress' })
    )
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'retry after compaction'
    })
    const activeRun = useSessionStore.getState().sessions[0].activeRun

    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'compact-done', kind: 'compaction', status: 'completed' })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'compact-failed',
        kind: 'compaction',
        status: 'failed',
        text: 'late failure'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'compact-late-start', kind: 'compaction', status: 'in_progress' })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      activeRun,
      compacting: undefined,
      error: undefined
    })
  })

  it('leaves overflow compaction terminal state to the recovery retry owner', async () => {
    useSessionStore.getState().finishRun('transport-session-1')
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'overflow-compact-start',
        kind: 'compaction',
        compactionReason: 'overflow-recovery',
        status: 'in_progress'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'overflow-compact-failed',
        kind: 'compaction',
        compactionReason: 'overflow-recovery',
        status: 'failed',
        text: 'native compaction failed'
      })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      compacting: true,
      error: undefined
    })

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'fallback retry'
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      compacting: undefined,
      error: undefined
    })
  })

  const overflowEvent = (): AcpRuntimeEvent =>
    createEvent({
      id: 'event-overflow',
      kind: 'error',
      level: 'error',
      recoverable: 'context-overflow',
      title: 'Prompt failed',
      text: 'Internal error: Request too large (max 32MB).'
    })

  it('defers to the neutral compacting note while a recovery is already in flight', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'compare these screenshots'
    })
    // The recovery effect flips the session to compacting before this event is applied.
    useSessionStore.getState().beginCompaction('transport-session-1', { supersedeActiveRun: true })

    const applied = await applyWorkspaceRuntimeEvent({
      ...overflowEvent(),
      terminalContextWindow: {
        termination: { kind: 'error' },
        contextWindow: { used: 127_000, size: 128_000 },
        source: 'provider-update'
      }
    })

    expect(applied).toBe(true)
    const session = useSessionStore.getState().sessions[0]
    // Stays neutral: no dead-end error surfaced while the recovery runs.
    expect(session.compacting).toBe(true)
    expect(session.status).not.toBe('error')
    expect(session.error).toBeUndefined()
    expect(session.messages[0].contextWindowSamples).toBeUndefined()
  })

  it('surfaces a real error for a recoverable overflow when no recovery started (e.g. cooldown)', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'compare these screenshots'
    })
    // Session is NOT compacting — a repeat overflow inside the cooldown gets no recovery, so it must not
    // be left in a stuck "Compacting…"; the error becomes visible instead.
    const applied = await applyWorkspaceRuntimeEvent(overflowEvent())

    expect(applied).toBe(true)
    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('error')
    expect(session.compacting).toBeFalsy()
    expect(session.error).toContain('Request too large')
    // A non-recovered overflow (providerError=false) is a client-side/size failure the text tier
    // recognizes as expected — it must NOT be forced reportable by the event path.
    expect(session.errorReportable).toBe(false)
  })

  it('hides the report button for a provider-tagged error even when its text looks reportable', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'run the analysis'
    })

    // providerError=true forces reportable=false regardless of the (opaque) message — the structural
    // tag, not the text, decides for a model/provider failure.
    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-provider',
        kind: 'error',
        level: 'error',
        providerError: true,
        title: 'Prompt failed',
        text: 'Internal error: upstream exploded'
      })
    )

    expect(applied).toBe(true)
    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('error')
    expect(session.errorReportable).toBe(false)
  })

  it('projects a Claude Code mid-response connection closure as a resumable interrupted turn', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-partial-response',
        role: 'assistant',
        messageId: 'assistant-message-1',
        promptMessageId,
        text: 'The first result is complete. Next I will'
      })
    )

    const errorText =
      'Internal error: API Error: Connection closed mid-response. The response above may be incomplete.'
    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-mid-response-closed',
        kind: 'error',
        level: 'error',
        providerError: true,
        promptMessageId,
        title: 'Prompt failed',
        text: errorText,
        turnUsage: { inputTokens: 21, cacheTokens: 8, outputTokens: 13, turnCount: 1 }
      })
    )

    expect(applied).toBe(true)
    const session = useSessionStore.getState().sessions[0]
    expect(session).toMatchObject({
      status: 'error',
      interrupted: true,
      error: errorText,
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'connection-lost',
        promptMessageId
      }
    })
    expect(session.errorReportable).toBeUndefined()
    expect(session.messages[0]).toMatchObject({ id: promptMessageId, interrupted: true })
    expect(session.messages[1]).toMatchObject({
      content: 'The first result is complete. Next I will',
      status: 'error',
      turnUsage: { inputTokens: 21, cacheTokens: 8, outputTokens: 13, turnCount: 1 }
    })
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

  it('suppresses non-actionable Codex startup and transport fallback diagnostics', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        agentFrameworkId: 'codex'
      }))
    }))
    const diagnostic = [
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget.',
      'Codex can still see every skill, but some descriptions are shorter.',
      'Disable unused skills or plugins to leave more room for the rest.',
      '',
      'Warning: Falling back from WebSockets to HTTPS transport. request timed out',
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget.',
      'Codex can still see every skill, but some descriptions are shorter.',
      'Disable unused skills or plugins to leave more room for the rest.',
      '',
      'Warning: Falling back from WebSockets to HTTPS transport. request timed out'
    ].join('\n')

    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'event-codex-warning', kind: 'system', level: 'warning', text: diagnostic })
    )

    expect(applied).toBe(true)
    expect(useSessionStore.getState().sessions[0].agentStatus).toBeUndefined()
  })

  it('surfaces Codex-shaped diagnostics from non-Codex sessions', async () => {
    const diagnostic = 'Warning: Falling back from WebSockets to HTTPS transport. request timed out'

    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'event-other-warning', kind: 'system', level: 'warning', text: diagnostic })
    )

    expect(applied).toBe(true)
    expect(useSessionStore.getState().sessions[0].agentStatus).toBe(diagnostic)
  })

  it('does not append Codex diagnostic assistant chunks to the transcript', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        agentFrameworkId: 'codex'
      }))
    }))
    const diagnostic = [
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget.',
      'Codex can still see every skill, but some descriptions are shorter.',
      'Disable unused skills or plugins to leave more room for the rest.',
      '',
      'Warning: Falling back from WebSockets to HTTPS transport. request timed out'
    ].join('\n')

    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-codex-message-warning',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: diagnostic
      })
    )

    expect(applied).toBe(true)
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(1)
  })

  it('does not project thought events into the transcript', async () => {
    const sessionBefore = useSessionStore.getState().sessions[0]

    const applied = await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-thought-1',
        kind: 'thought',
        role: 'assistant',
        text: 'I will inspect the notebook next.'
      })
    )

    expect(applied).toBe(false)
    expect(useSessionStore.getState().sessions[0]).toBe(sessionBefore)
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

  it('mirrors only request-correlated restored permission lifecycle events', async () => {
    const request = createPermissionRequest()
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'idle',
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'continuing',
            request,
            originatingPromptMessageId: session.messages[0].id,
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        }
      }))
    }))

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'permission-rearmed-uncorrelated',
        kind: 'permission',
        title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
      })
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      runtimeContext: { permission: { state: 'continuing' } }
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'permission-rearmed-mismatch',
        kind: 'permission',
        title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
        permissionRequestId: 'permission-other'
      })
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      runtimeContext: { permission: { state: 'continuing' } }
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'permission-rearmed',
        kind: 'permission',
        title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
        permissionRequestId: request.requestId
      })
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      runtimeContext: { permission: { state: 'pending' } }
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'permission-settled-mismatch',
        kind: 'permission',
        title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
        permissionRequestId: 'permission-other'
      })
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      runtimeContext: { permission: { state: 'pending' } }
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'permission-settled',
        kind: 'permission',
        title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
        permissionRequestId: request.requestId
      })
    )
    expect(useSessionStore.getState().sessions[0].runtimeContext?.permission).toBeUndefined()
  })

  it('syncs first-output waiting only for known foreground workspace sessions', () => {
    syncWorkspaceAgentFirstOutputState(['transport-session-1', 'reviewer-session-1'])
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true
    })

    syncWorkspaceAgentFirstOutputState([])
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      agentPromptInFlight: undefined,
      awaitingFirstAgentOutput: undefined
    })
  })

  it('does not rearm first-output waiting from repeated in-flight snapshots after output', async () => {
    syncWorkspaceAgentFirstOutputState(['transport-session-1'])
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-first-output',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'First visible token'
      })
    )
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()

    syncWorkspaceAgentFirstOutputState(['transport-session-1'])
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()

    syncWorkspaceAgentFirstOutputState([])
    syncWorkspaceAgentFirstOutputState(['transport-session-1'])
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBe(true)
  })

  it('keeps first-output waiting through tools and filtered Agent diagnostics', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        agentFrameworkId: 'codex'
      }))
    }))
    syncWorkspaceAgentFirstOutputState(['transport-session-1'])

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-tool-before-output',
        kind: 'tool',
        toolCallId: 'tool-before-output',
        title: 'Inspect files',
        status: 'in_progress'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-filtered-diagnostic',
        role: 'assistant',
        messageId: 'assistant-diagnostic',
        text: 'Warning: Falling back from WebSockets to HTTPS transport. request timed out'
      })
    )

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBe(true)
  })

  it('does not rearm waiting from a terminal tool event for an older prompt', async () => {
    const oldPromptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Current request'
    })
    syncWorkspaceAgentFirstOutputState(['transport-session-1'])
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-current-output',
        role: 'assistant',
        messageId: 'assistant-message-current',
        text: 'Current response started'
      })
    )

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-old-tool-completed',
        kind: 'tool',
        toolCallId: 'old-tool',
        promptMessageId: oldPromptMessageId,
        status: 'completed'
      })
    )

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
  })

  it('does not rearm waiting or reorder a tool for repeated terminal updates', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    syncWorkspaceAgentFirstOutputState(['transport-session-1'])
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-tool-running',
        kind: 'tool',
        toolCallId: 'tool-1',
        promptMessageId,
        status: 'in_progress'
      })
    )
    vi.setSystemTime(new Date('2026-07-04T08:00:01.000Z'))
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-tool-completed',
        kind: 'tool',
        toolCallId: 'tool-1',
        promptMessageId,
        status: 'completed'
      })
    )
    const completedAt = useSessionStore.getState().sessions[0].activities?.[0].updatedAt
    vi.setSystemTime(new Date('2026-07-04T08:00:02.000Z'))
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-output-after-tool',
        role: 'assistant',
        messageId: 'assistant-message-1',
        promptMessageId,
        text: 'Tool result received'
      })
    )

    vi.setSystemTime(new Date('2026-07-04T08:00:03.000Z'))
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-tool-completed-metadata',
        kind: 'tool',
        toolCallId: 'tool-1',
        promptMessageId,
        status: 'completed',
        rawOutput: { result: 'ok' }
      })
    )

    const session = useSessionStore.getState().sessions[0]
    expect(session.awaitingFirstAgentOutput).toBeUndefined()
    expect(session.activities?.[0]).toMatchObject({
      updatedAt: completedAt,
      rawOutput: { result: 'ok' }
    })
  })

  it('ignores a terminal tool event that arrives after the run stops', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    syncWorkspaceAgentFirstOutputState(['transport-session-1'])
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-tool-running-before-stop',
        kind: 'tool',
        toolCallId: 'tool-before-stop',
        promptMessageId,
        status: 'in_progress'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'event-stop-before-tool-terminal', kind: 'stop', promptMessageId })
    )

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-tool-terminal-after-stop',
        kind: 'tool',
        toolCallId: 'tool-before-stop',
        promptMessageId,
        status: 'completed'
      })
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      agentPromptInFlight: undefined,
      awaitingFirstAgentOutput: undefined
    })
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
    } as unknown as AcpRuntimeEvent)

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
        timestamp: 10,
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
        timestamp: 25,
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
        createdAt: 10,
        updatedAt: 25,
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

  it('merges and persists elicitation state on its tool activity', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'elicitation-event-1',
        kind: 'tool',
        toolCallId: 'tool-ask-1',
        title: 'Choose an approach',
        status: 'pending',
        elicitation: {
          message: 'Choose an approach',
          state: 'pending',
          fields: [
            {
              id: 'approach',
              label: 'Approach',
              kind: 'single-select',
              options: [{ value: 'minimal', label: 'Minimal change' }]
            }
          ]
        }
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'elicitation-event-2',
        kind: 'tool',
        toolCallId: 'tool-ask-1',
        status: 'pending',
        elicitation: {
          message: 'Choose an approach',
          state: 'answered',
          fields: [
            {
              id: 'approach',
              label: 'Approach',
              kind: 'single-select',
              options: [{ value: 'minimal', label: 'Minimal change' }]
            }
          ],
          answers: [{ fieldId: 'approach', value: 'minimal' }],
          respondedAt: 1710000001000
        }
      })
    )

    const session = useSessionStore.getState().sessions[0]
    expect(session.activities).toEqual([
      expect.objectContaining({
        id: 'tool-ask-1',
        eventIds: ['elicitation-event-1', 'elicitation-event-2'],
        elicitation: expect.objectContaining({
          state: 'answered',
          answers: [{ fieldId: 'approach', value: 'minimal' }]
        })
      })
    ])
    expect(toPersistedSession(session).activities).toEqual([
      expect.objectContaining({
        elicitation: expect.objectContaining({ state: 'answered' })
      })
    ])
  })

  it('finishes a turn normally while a durable user choice remains pending', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'choice-pending',
        kind: 'tool',
        toolCallId: 'choice-tool',
        promptMessageId,
        status: 'pending',
        elicitation: {
          message: 'Choose an approach',
          state: 'pending',
          durable: {
            kind: 'agent-user-choice',
            requestId: 'choice-request',
            ...(promptMessageId ? { promptMessageId } : {})
          },
          fields: [
            {
              id: 'question_0',
              label: 'Approach',
              kind: 'single-select',
              options: [
                { value: 'minimal', label: 'Minimal' },
                { value: 'expanded', label: 'Expanded' }
              ]
            },
            { id: 'question_0_custom', label: 'Other', kind: 'text' }
          ]
        }
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'choice-turn-stop', kind: 'stop', text: 'end_turn', promptMessageId })
    )

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('idle')
    expect(session.interrupted).toBeUndefined()
    expect(session.resumeRecovery).toBeUndefined()
    expect(session.activities?.[0].elicitation?.state).toBe('pending')
  })

  it('attaches artifact events to the current message and finalizes their file paths', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
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
    const saveSession = vi.fn().mockResolvedValue(undefined)

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-1',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'Saved the result.'
      })
    )
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-artifact', kind: 'stop' }))

    const wasApplied = await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-1',
        kind: 'artifact',
        runId: 'run-1',
        promptMessageId,
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-1',
        artifacts: [createArtifactFile()]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    const session = useSessionStore.getState().sessions[0]
    const message = session.messages[1]

    expect(wasApplied).toBe(true)
    expect(finalizeRunArtifacts).toHaveBeenCalledWith({
      claimId: 'claim-1',
      messageId: message.id
    })
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'transport-session-1',
        conversationGraph: expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({ id: message.id })])
        })
      })
    )
    expect(message).toMatchObject({
      role: 'agent',
      content: 'Saved the result.',
      artifactIds: ['transport-session-1:message-1:result.txt']
    })
    expect(session.artifacts).toEqual([
      expect.objectContaining({
        id: 'transport-session-1:message-1:result.txt',
        path: expect.stringContaining('/transport-session-1/message-1/result.txt')
      })
    ])
  })

  it('attaches a post-stop artifact event to the completed response for its prompt', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-1',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'Saved the plot.'
      })
    )
    const responseMessageId = useSessionStore.getState().sessions[0].messages[1].id

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

    const operationOrder: string[] = []
    const saveSession = vi.fn().mockImplementation(async () => {
      operationOrder.push('save')
    })
    const finalizeRunArtifacts = vi.fn().mockImplementation(async () => {
      operationOrder.push('finalize')
      return [
        createArtifactFile({
          id: `transport-session-1:${responseMessageId}:result.txt`,
          sessionId: 'transport-session-1',
          messageId: responseMessageId,
          runId: undefined
        })
      ]
    })
    const artifactEvent = createEvent({
      id: 'artifact-event-after-stop',
      kind: 'artifact',
      runId: 'artifact-run-1',
      promptMessageId,
      artifactSessionId: 'artifact-session-1',
      artifactClaimId: 'claim-1',
      artifacts: [createArtifactFile({ runId: 'artifact-run-1' })]
    })

    await applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts, saveSession })

    const session = useSessionStore.getState().sessions[0]
    expect(finalizeRunArtifacts).toHaveBeenCalledWith({
      claimId: 'claim-1',
      messageId: responseMessageId
    })
    expect(operationOrder).toEqual(['save', 'finalize', 'save'])
    expect(saveSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        artifacts: [
          expect.objectContaining({ id: `transport-session-1:${responseMessageId}:result.txt` })
        ],
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: responseMessageId,
            artifactIds: [`transport-session-1:${responseMessageId}:result.txt`]
          })
        ])
      })
    )
    expect(session.messages).toHaveLength(2)
    expect(session.messages[1].artifactIds).toEqual([
      `transport-session-1:${responseMessageId}:result.txt`
    ])
  })

  it('keeps a successful artifact finalization complete when the projection save conflicts', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-before-save-conflict',
        role: 'assistant',
        messageId: 'assistant-before-save-conflict',
        text: 'Saved the result.'
      })
    )
    const responseMessageId = useSessionStore.getState().sessions[0].messages[1].id
    const finalizedArtifact = createArtifactFile({
      id: `transport-session-1:${responseMessageId}:result.txt`,
      sessionId: 'transport-session-1',
      messageId: responseMessageId,
      runId: undefined
    })
    const operationOrder: string[] = []
    const finalizeRunArtifacts = vi.fn().mockImplementation(async () => {
      operationOrder.push('finalize')
      return [finalizedArtifact]
    })
    const revisionConflict = new SessionRevisionConflictError(562, 567)
    const saveSession = vi.fn(async () => {
      operationOrder.push('save')
      if (operationOrder.length === 3) throw revisionConflict
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-before-save-conflict',
        kind: 'artifact',
        runId: 'artifact-run-before-save-conflict',
        promptMessageId,
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-before-save-conflict',
        artifacts: [createArtifactFile({ runId: 'artifact-run-before-save-conflict' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    const failure = await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-after-finalization', kind: 'stop', text: 'end_turn' })
    ).then(
      () => undefined,
      (error: unknown) => error
    )

    const session = useSessionStore.getState().sessions[0]
    expect(finalizeRunArtifacts).toHaveBeenCalledOnce()
    expect(operationOrder).toEqual(['save', 'finalize', 'save'])
    expect(session).toMatchObject({
      status: 'idle',
      activeRun: undefined,
      error: undefined
    })
    expect(session.messages[1]).toMatchObject({
      id: responseMessageId,
      status: 'complete',
      artifactIds: [finalizedArtifact.id]
    })
    expect(failure).toBe(revisionConflict)
  })

  it.each([
    {
      label: 'reported',
      turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 },
      expectedUsage: {
        turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 }
      }
    },
    {
      label: 'unavailable',
      turnUsage: undefined,
      expectedUsage: { turnUsageUnavailable: true }
    }
  ])('preserves $label usage for an artifact-only response received after stop', async (input) => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    const saveSession = vi.fn().mockResolvedValue(undefined)
    const finalizeRunArtifacts = vi.fn(async ({ messageId }: { messageId: string }) => [
      createArtifactFile({
        id: `transport-session-1:${messageId}:result.txt`,
        sessionId: 'transport-session-1',
        messageId,
        runId: undefined
      })
    ])

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: `stop-before-artifact-only-${input.label}`,
        kind: 'stop',
        turnUsage: input.turnUsage
      })
    )
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(1)

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: `artifact-only-after-stop-${input.label}`,
        kind: 'artifact',
        runId: `artifact-run-after-stop-${input.label}`,
        promptMessageId,
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: `claim-after-stop-${input.label}`,
        artifacts: [createArtifactFile({ runId: `artifact-run-after-stop-${input.label}` })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      role: 'agent',
      content: '',
      status: 'complete',
      ...input.expectedUsage
    })
    expect(saveSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'agent', ...input.expectedUsage })
        ])
      })
    )
  })

  it('keeps pending artifact usage isolated across consecutive prompts', async () => {
    const firstPromptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    const firstTurnUsage = { inputTokens: 31, cacheTokens: 15, outputTokens: 14 }
    const secondTurnUsage = { inputTokens: 47, cacheTokens: 9, outputTokens: 22 }
    const saveSession = vi.fn().mockResolvedValue(undefined)
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([])

    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'first-stop-before-artifact', kind: 'stop', turnUsage: firstTurnUsage })
    )
    const secondPrompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create another artifact'
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'second-stop-before-artifact', kind: 'stop', turnUsage: secondTurnUsage })
    )

    for (const [label, promptMessageId] of [
      ['first', firstPromptMessageId],
      ['second', secondPrompt?.messageId]
    ] as const) {
      await applyWorkspaceRuntimeEvent(
        createEvent({
          id: `${label}-late-artifact`,
          kind: 'artifact',
          runId: `${label}-artifact-run`,
          promptMessageId,
          artifactSessionId: 'artifact-session-1',
          artifactClaimId: `${label}-artifact-claim`,
          artifacts: [createArtifactFile({ runId: `${label}-artifact-run` })]
        }),
        { finalizeRunArtifacts, saveSession }
      )
    }

    const messages = useSessionStore.getState().sessions[0].messages
    expect(
      messages.find((message) => message.responseToMessageId === firstPromptMessageId)
    ).toMatchObject({
      role: 'agent',
      turnUsage: firstTurnUsage
    })
    expect(
      messages.find((message) => message.responseToMessageId === secondPrompt?.messageId)
    ).toMatchObject({
      role: 'agent',
      turnUsage: secondTurnUsage
    })
  })

  it('keeps Artifact persistence behind an older queued Session save', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-ordered-save',
        role: 'assistant',
        messageId: 'assistant-message-ordered-save',
        text: 'Saved the plot.'
      })
    )
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-ordered-save', kind: 'stop' }))

    let releaseQueuedSave!: () => void
    const queuedSaveBlocked = new Promise<void>((resolve) => {
      releaseQueuedSave = resolve
    })
    let durableTitle = ''
    const saveSession = vi.fn(async (submitted: ReturnType<typeof toPersistedSession>) => {
      if (submitted.title === 'Queued stale') await queuedSaveBlocked
      durableTitle = submitted.title
      return submitted
    })
    vi.stubGlobal('window', {
      api: {
        sessions: {
          saveSession,
          saveManifest: vi.fn()
        }
      }
    })

    try {
      const staleSession = toPersistedSession(useSessionStore.getState().sessions[0])
      const queuedSave = saveSessionInOrder({ ...staleSession, title: 'Queued stale' })
      await Promise.resolve()
      await Promise.resolve()
      useSessionStore.getState().renameSession('transport-session-1', 'Artifact latest')
      const responseMessageId = useSessionStore.getState().sessions[0].messages[1].id
      const finalizedArtifact = createArtifactFile({
        id: `transport-session-1:${responseMessageId}:result.txt`,
        sessionId: 'transport-session-1',
        messageId: responseMessageId,
        runId: undefined
      })
      const artifactSave = applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'artifact-event-ordered-save',
          kind: 'artifact',
          runId: 'artifact-run-ordered-save',
          promptMessageId,
          artifactSessionId: 'artifact-session-1',
          artifactClaimId: 'claim-ordered-save',
          artifacts: [createArtifactFile({ runId: 'artifact-run-ordered-save' })]
        }),
        { finalizeRunArtifacts: vi.fn().mockResolvedValue([finalizedArtifact]) }
      )

      await Promise.resolve()
      await Promise.resolve()
      const writesBeforeRelease = saveSession.mock.calls.length
      releaseQueuedSave()
      await Promise.all([queuedSave, artifactSave])

      expect(writesBeforeRelease).toBe(1)
      expect(durableTitle).toBe('Artifact latest')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retains an unchanged post-stop Artifact after switching an edited Branch away and back', async () => {
    const originalPromptMessageId =
      useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-original',
        role: 'assistant',
        messageId: 'assistant-message-original',
        text: 'Saved the original plot.'
      })
    )
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-original', kind: 'stop' }))

    const originalBranchId =
      useSessionStore.getState().sessions[0].conversationGraph?.frames[0].activeBranchId
    useSessionStore
      .getState()
      .truncateSessionFromMessage('transport-session-1', originalPromptMessageId ?? '')
    const editedPrompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Save an edited plot'
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-edited',
        role: 'assistant',
        messageId: 'assistant-message-edited',
        text: 'Saved the edited plot.'
      })
    )
    const responseMessageId = useSessionStore.getState().sessions[0].messages.at(-1)?.id
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-edited', kind: 'stop' }))

    const artifact = createArtifactFile({
      id: 'artifact-version-2',
      sessionId: 'transport-session-1',
      messageId: responseMessageId,
      runId: 'artifact-run-2'
    })
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([artifact])
    const saveSession = vi.fn().mockResolvedValue(undefined)
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-after-edited-stop',
        kind: 'artifact',
        runId: 'artifact-run-2',
        promptMessageId: editedPrompt?.messageId,
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-edited',
        artifacts: [artifact]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    const beforeSwitch = useSessionStore.getState().sessions[0]
    const editedBranchId = beforeSwitch.conversationGraph?.frames[0].activeBranchId
    expect(beforeSwitch.messages.at(-1)?.artifactIds).toEqual(['artifact-version-2'])

    useSessionStore.getState().activateMessageBranch('transport-session-1', originalBranchId ?? '')
    useSessionStore.getState().activateMessageBranch('transport-session-1', editedBranchId ?? '')

    expect(useSessionStore.getState().sessions[0].messages.at(-1)).toMatchObject({
      id: responseMessageId,
      artifactIds: ['artifact-version-2']
    })
  })

  it('waits for stop before binding an artifact to the terminal response for its prompt', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-before-artifact',
        role: 'assistant',
        messageId: 'assistant-message-before-artifact',
        text: 'Now let me save it as an artifact:'
      })
    )
    const intermediateMessageId = useSessionStore.getState().sessions[0].messages[1].id
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([
      createArtifactFile({
        id: 'transport-session-1:terminal-message:result.txt',
        sessionId: 'transport-session-1',
        messageId: 'terminal-message',
        runId: undefined
      })
    ])
    const saveSession = vi.fn().mockResolvedValue(undefined)

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-before-stop',
        kind: 'artifact',
        runId: 'artifact-run-before-stop',
        promptMessageId,
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-before-stop',
        artifacts: [createArtifactFile({ runId: 'artifact-run-before-stop' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    expect(finalizeRunArtifacts).not.toHaveBeenCalled()

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-after-artifact',
        role: 'assistant',
        messageId: 'assistant-message-after-artifact',
        text: 'The chart is complete.'
      })
    )
    const terminalMessageId = useSessionStore.getState().sessions[0].messages[2].id
    finalizeRunArtifacts.mockResolvedValue([
      createArtifactFile({
        id: `transport-session-1:${terminalMessageId}:result.txt`,
        sessionId: 'transport-session-1',
        messageId: terminalMessageId,
        runId: undefined
      })
    ])

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-after-artifact', kind: 'stop' }), {
      finalizeRunArtifacts,
      saveSession
    })

    expect(finalizeRunArtifacts).toHaveBeenCalledWith({
      claimId: 'claim-before-stop',
      messageId: terminalMessageId
    })
    expect(finalizeRunArtifacts).not.toHaveBeenCalledWith({
      claimId: 'claim-before-stop',
      messageId: intermediateMessageId
    })
  })

  it('attaches turn usage to an artifact-only terminal response', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    const finalizeRunArtifacts = vi.fn(async ({ messageId }: { messageId: string }) => [
      createArtifactFile({
        id: `transport-session-1:${messageId}:result.txt`,
        sessionId: 'transport-session-1',
        messageId,
        runId: undefined
      })
    ])
    const saveSession = vi.fn().mockResolvedValue(undefined)

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-only-response',
        kind: 'artifact',
        runId: 'artifact-run-only-response',
        promptMessageId,
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-only-response',
        artifacts: [createArtifactFile({ runId: 'artifact-run-only-response' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'stop-only-response',
        kind: 'stop',
        turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 }
      })
    )

    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      role: 'agent',
      content: '',
      status: 'complete',
      artifactIds: [expect.stringContaining(':result.txt')],
      turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 }
    })
    expect(saveSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'agent',
            turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 }
          })
        ])
      })
    )
  })

  it('marks an artifact-only terminal response when turn usage is unavailable', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-only-unavailable-response',
        kind: 'artifact',
        runId: 'artifact-run-only-unavailable-response',
        promptMessageId,
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-only-unavailable-response',
        artifacts: [createArtifactFile({ runId: 'artifact-run-only-unavailable-response' })]
      }),
      {
        finalizeRunArtifacts: vi.fn().mockResolvedValue([]),
        saveSession: vi.fn().mockResolvedValue(undefined)
      }
    )

    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-only-unavailable-response', kind: 'stop' })
    )

    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      role: 'agent',
      content: '',
      status: 'complete',
      turnUsageUnavailable: true
    })
  })

  it('binds a restarted runtime Artifact event to the current response in a historical Session', async () => {
    const finalizeRunArtifacts = vi.fn(async ({ messageId }: { messageId: string }) => [
      createArtifactFile({
        id: `transport-session-1:${messageId}:result.txt`,
        sessionId: 'transport-session-1',
        messageId,
        runId: undefined
      })
    ])
    const saveSession = vi.fn().mockResolvedValue(undefined)
    const historicalPromptMessageId =
      useSessionStore.getState().sessions[0].activeRun?.promptMessageId

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'runtime-1:acp-event-1',
        role: 'assistant',
        messageId: 'historical-assistant-stream',
        text: 'Historical response'
      })
    )
    const historicalResponseMessageId = useSessionStore.getState().sessions[0].messages.at(-1)?.id
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'runtime-1:acp-event-2',
        kind: 'artifact',
        runId: 'historical-artifact-run',
        promptMessageId: historicalPromptMessageId,
        artifactClaimId: 'historical-claim',
        artifacts: [
          createArtifactFile({ id: 'historical-version', runId: 'historical-artifact-run' })
        ]
      }),
      { finalizeRunArtifacts, saveSession }
    )
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'historical-stop', kind: 'stop' }))

    const currentPrompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a new result after restart'
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({
        // Historical Sessions may already contain ids from the legacy restarting namespace.
        id: 'runtime-1:acp-event-1',
        role: 'assistant',
        messageId: 'current-assistant-stream',
        text: 'Current response'
      })
    )
    const currentResponseMessageId = useSessionStore.getState().sessions[0].messages.at(-1)?.id
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'runtime-1:acp-event-2',
        kind: 'artifact',
        runId: 'current-artifact-run',
        promptMessageId: currentPrompt?.messageId,
        artifactClaimId: 'current-claim',
        artifacts: [createArtifactFile({ id: 'current-version', runId: 'current-artifact-run' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'current-stop', kind: 'stop' }))

    expect(currentResponseMessageId).not.toBe(historicalResponseMessageId)
    expect(finalizeRunArtifacts).toHaveBeenLastCalledWith({
      claimId: 'current-claim',
      messageId: currentResponseMessageId
    })
  })

  it('finalizes every artifact claim deferred before the same stop event', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-1',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: 'Saving two files.'
      })
    )
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([])
    const saveSession = vi.fn().mockResolvedValue(undefined)

    for (const claimId of ['claim-a', 'claim-b']) {
      await applyWorkspaceRuntimeEvent(
        createEvent({
          id: `artifact-${claimId}`,
          kind: 'artifact',
          runId: `run-${claimId}`,
          promptMessageId,
          artifactSessionId: 'artifact-session-1',
          artifactClaimId: claimId,
          artifacts: [createArtifactFile({ runId: `run-${claimId}` })]
        }),
        { finalizeRunArtifacts, saveSession }
      )
    }

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

    expect(finalizeRunArtifacts).toHaveBeenCalledTimes(2)
    expect(finalizeRunArtifacts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ claimId: 'claim-a' })
    )
    expect(finalizeRunArtifacts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ claimId: 'claim-b' })
    )
  })

  it('replays an inactive-branch artifact claim against its original response', async () => {
    const originalPromptMessageId =
      useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    let finalizedMessageId: string | undefined
    const finalizeRunArtifacts = vi.fn(async ({ messageId }: { messageId: string }) => {
      if (finalizedMessageId && finalizedMessageId !== messageId) {
        throw new Error(`Artifact run claim already finalized for message: ${finalizedMessageId}`)
      }
      finalizedMessageId = messageId
      return [
        createArtifactFile({
          id: `transport-session-1:${messageId}:result.txt`,
          sessionId: 'transport-session-1',
          messageId,
          runId: undefined
        })
      ]
    })
    const saveSession = vi.fn().mockResolvedValue(undefined)
    const artifactEvent = createEvent({
      id: 'artifact-event-inactive-branch',
      kind: 'artifact',
      runId: 'artifact-run-inactive-branch',
      promptMessageId: originalPromptMessageId,
      artifactSessionId: 'artifact-session-1',
      artifactClaimId: 'claim-inactive-branch',
      artifacts: [createArtifactFile({ runId: 'artifact-run-inactive-branch' })]
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-inactive-branch',
        role: 'assistant',
        messageId: 'assistant-message-inactive-branch',
        text: 'Saved the inactive branch result.'
      })
    )
    await applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts, saveSession })
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-inactive-branch', kind: 'stop' }), {
      finalizeRunArtifacts,
      saveSession
    })

    const originalResponseMessageId = finalizedMessageId
    expect(originalResponseMessageId).toBeDefined()
    expect(
      useSessionStore
        .getState()
        .sessions[0].conversationGraph?.messages.find(
          (message) => message.id === originalResponseMessageId
        )
    ).toMatchObject({
      id: originalResponseMessageId,
      responseToMessageId: originalPromptMessageId
    })

    useSessionStore
      .getState()
      .truncateSessionFromMessage('transport-session-1', originalPromptMessageId ?? '')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a different version'
    })
    expect(
      useSessionStore
        .getState()
        .sessions[0].conversationGraph?.messages.find(
          (message) => message.id === originalResponseMessageId
        )
    ).toMatchObject({
      id: originalResponseMessageId,
      responseToMessageId: originalPromptMessageId
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-current-branch',
        role: 'assistant',
        messageId: 'assistant-message-current-branch',
        text: 'Saved the current branch result.'
      })
    )
    await applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts, saveSession })

    await expect(
      applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-current-branch', kind: 'stop' }), {
        finalizeRunArtifacts,
        saveSession
      })
    ).resolves.toBe(true)

    expect(finalizeRunArtifacts).toHaveBeenCalledTimes(2)
    expect(finalizeRunArtifacts).toHaveBeenLastCalledWith({
      claimId: 'claim-inactive-branch',
      messageId: originalResponseMessageId
    })
    const session = useSessionStore.getState().sessions[0]
    expect(session.messages.every((message) => (message.artifactIds?.length ?? 0) === 0)).toBe(true)
    expect(
      session.conversationGraph?.messages.find(
        (message) => message.id === originalResponseMessageId
      )?.artifactIds
    ).toEqual([`transport-session-1:${originalResponseMessageId}:result.txt`])
  })

  it('acknowledges stop without finalizing deferred evidence after graph synchronization fails', async () => {
    const finalizeRunArtifacts = vi.fn()
    const saveSession = vi.fn()
    const reviewerRun = vi.fn().mockResolvedValue({ started: true })
    stubReviewerApi(reviewerRun)
    useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-before-invalid-stop',
        role: 'assistant',
        messageId: 'assistant-before-invalid-stop',
        text: 'Terminal response'
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-before-invalid-stop',
        kind: 'artifact',
        runId: 'artifact-run-invalid-graph',
        artifactClaimId: 'claim-invalid-graph',
        artifacts: [createArtifactFile({ runId: 'artifact-run-invalid-graph' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'transport-session-1' && session.conversationGraph
          ? {
              ...session,
              conversationGraph: {
                ...session.conversationGraph,
                activeFrameId: 'missing-active-frame'
              }
            }
          : session
      )
    }))

    await expect(
      applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-invalid-graph', kind: 'stop' }), {
        finalizeRunArtifacts,
        saveSession
      })
    ).resolves.toBe(true)

    expect(finalizeRunArtifacts).not.toHaveBeenCalled()
    expect(saveSession).not.toHaveBeenCalled()
    expect(reviewerRun).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      conversationGraphSyncBlocked: true
    })
    vi.unstubAllGlobals()
  })

  it('discards deferred evidence when an error terminal event cannot synchronize its graph', async () => {
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([])
    const saveSession = vi.fn().mockResolvedValue(undefined)
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-before-invalid-error',
        kind: 'artifact',
        runId: 'artifact-run-invalid-error',
        artifactClaimId: 'claim-invalid-error',
        artifacts: [createArtifactFile({ runId: 'artifact-run-invalid-error' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    const validGraph = useSessionStore.getState().sessions[0].conversationGraph
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'transport-session-1' && session.conversationGraph
          ? {
              ...session,
              conversationGraph: {
                ...session.conversationGraph,
                activeFrameId: 'missing-active-frame'
              }
            }
          : session
      )
    }))

    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'error-invalid-graph', kind: 'error', text: 'Provider failed' })
    )

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'transport-session-1'
          ? {
              ...session,
              status: 'running',
              activeRun: { promptMessageId: session.messages[0].id, startedAt: Date.now() },
              conversationGraph: validGraph,
              conversationGraphSyncBlocked: undefined
            }
          : session
      )
    }))
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-after-invalid-error', kind: 'stop' }),
      {
        finalizeRunArtifacts,
        saveSession
      }
    )

    expect(finalizeRunArtifacts).not.toHaveBeenCalled()
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('re-saves the latest durable graph once when finalization observes an ownership race', async () => {
    const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-ownership-race',
        role: 'assistant',
        messageId: 'assistant-message-ownership-race',
        text: 'Saved the plot.'
      })
    )
    const responseMessageId = useSessionStore.getState().sessions[0].messages[1].id
    const operationOrder: string[] = []
    const saveSession = vi.fn().mockImplementation(async () => {
      operationOrder.push('save')
    })
    const finalizedArtifact = createArtifactFile({
      id: `transport-session-1:${responseMessageId}:result.txt`,
      sessionId: 'transport-session-1',
      messageId: responseMessageId,
      runId: undefined
    })
    const finalizeRunArtifacts = vi
      .fn()
      .mockImplementationOnce(async () => {
        operationOrder.push('finalize')
        throw Object.assign(
          new Error('The durable projection has not caught up with the selected message yet.'),
          { code: ARTIFACT_OWNERSHIP_PERSISTENCE_RACE }
        )
      })
      .mockImplementationOnce(async () => {
        operationOrder.push('finalize')
        return [finalizedArtifact]
      })

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-race', kind: 'stop' }))

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-ownership-race',
        kind: 'artifact',
        runId: 'artifact-run-ownership-race',
        promptMessageId,
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-ownership-race',
        artifacts: [createArtifactFile({ runId: 'artifact-run-ownership-race' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    expect(operationOrder).toEqual(['save', 'finalize', 'save', 'finalize', 'save'])
    expect(finalizeRunArtifacts).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
  })

  it('keeps a proof failure terminal when only its human message resembles the old race text', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-terminal-proof',
        role: 'assistant',
        messageId: 'assistant-message-terminal-proof',
        text: 'Saved the plot.'
      })
    )
    const operationOrder: string[] = []
    const saveSession = vi.fn().mockImplementation(async () => {
      operationOrder.push('save')
    })
    const finalizeRunArtifacts = vi.fn().mockImplementation(async () => {
      operationOrder.push('finalize')
      throw Object.assign(
        new Error('Artifact finalization message is not a Branch descendant of its prompt.'),
        { code: ARTIFACT_FINALIZATION_INVALID_PROOF }
      )
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-before-terminal-proof', kind: 'stop' })
    )

    await expect(
      applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'artifact-event-terminal-proof',
          kind: 'artifact',
          runId: 'artifact-run-terminal-proof',
          artifactClaimId: 'claim-terminal-proof',
          artifacts: [createArtifactFile({ runId: 'artifact-run-terminal-proof' })]
        }),
        { finalizeRunArtifacts, saveSession }
      )
    ).rejects.toThrow(/Branch descendant/)

    expect(operationOrder).toEqual(['save', 'finalize'])
    expect(finalizeRunArtifacts).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0].error).toMatch(
      /^Generated file finalization cannot be retried:/u
    )
  })

  it('attempts the recoverable ownership persistence race at most twice', async () => {
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'assistant-event-repeated-race',
        role: 'assistant',
        messageId: 'assistant-message-repeated-race',
        text: 'Saved the plot.'
      })
    )
    const race = Object.assign(new Error('Durable ownership is still unavailable.'), {
      code: ARTIFACT_OWNERSHIP_PERSISTENCE_RACE
    })
    const finalizeRunArtifacts = vi.fn().mockRejectedValue(race)
    const saveSession = vi.fn().mockResolvedValue(undefined)

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-repeated-race', kind: 'stop' }))

    await expect(
      applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'artifact-event-repeated-race',
          kind: 'artifact',
          runId: 'artifact-run-repeated-race',
          artifactClaimId: 'claim-repeated-race',
          artifacts: [createArtifactFile({ runId: 'artifact-run-repeated-race' })]
        }),
        { finalizeRunArtifacts, saveSession }
      )
    ).rejects.toThrow('Durable ownership is still unavailable.')

    expect(finalizeRunArtifacts).toHaveBeenCalledTimes(2)
    expect(saveSession).toHaveBeenCalledTimes(2)
  })

  it('auto-opens a generated molecule artifact in the preview panel', async () => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'default-project' })
    usePreviewWorkbenchStore.getState().activateProject('default-project')
    const finalizedArtifact = createArtifactFile({
      id: 'artifact-version-2',
      artifactId: 'artifact-lineage-1',
      versionId: 'artifact-version-2',
      versionNumber: 2,
      sessionId: 'transport-session-1',
      messageId: 'message-1',
      runId: undefined,
      name: 'aspirin.mol',
      path: '/Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/aspirin.mol',
      fileUrl:
        'file:///Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/aspirin.mol'
    })
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([finalizedArtifact])
    const saveSession = vi.fn().mockResolvedValue(undefined)

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-molecule', kind: 'stop' }))

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-1',
        kind: 'artifact',
        runId: 'run-1',
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-1',
        artifacts: [createArtifactFile({ name: 'aspirin.mol' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    const preview = usePreviewWorkbenchStore.getState()

    expect(preview.panelState).toBe('open')
    expect(preview.activeItemId).toBe('artifact-lineage-1')
    expect(preview.items).toEqual([
      expect.objectContaining({
        id: 'artifact-lineage-1',
        artifactId: 'artifact-lineage-1',
        versionNumber: 2,
        path: 'artifact-version:default-project/transport-session-1/artifact-lineage-1/artifact-version-2',
        type: 'file',
        format: 'molecule',
        name: 'aspirin.mol'
      })
    ])
  })

  it('waits for the foreground project preview slice before auto-opening a molecule', async () => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'default-project' })
    const finalizedArtifact = createArtifactFile({
      id: 'artifact-version-activating',
      artifactId: 'artifact-lineage-activating',
      versionId: 'artifact-version-activating',
      versionNumber: 1,
      sessionId: 'transport-session-1',
      messageId: 'message-1',
      runId: undefined,
      name: 'activating.mol'
    })

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-activating', kind: 'stop' }))
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-activating',
        kind: 'artifact',
        runId: 'run-activating',
        artifactSessionId: 'artifact-session-activating',
        artifactClaimId: 'claim-activating',
        artifacts: [createArtifactFile({ name: 'activating.mol' })]
      }),
      {
        finalizeRunArtifacts: vi.fn().mockResolvedValue([finalizedArtifact]),
        saveSession: vi.fn().mockResolvedValue(undefined)
      }
    )

    expect(usePreviewWorkbenchStore.getState().items).toEqual([])

    usePreviewWorkbenchStore.getState().activateProject('default-project')

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'artifact-lineage-activating',
      panelState: 'open',
      activeProjectId: 'default-project',
      items: [
        expect.objectContaining({
          id: 'artifact-lineage-activating',
          format: 'molecule'
        })
      ]
    })
  })

  it('does not auto-open a generated molecule artifact while Home is visible', async () => {
    const finalizedArtifact = createArtifactFile({
      id: 'artifact-version-home',
      artifactId: 'artifact-lineage-home',
      versionId: 'artifact-version-home',
      versionNumber: 1,
      sessionId: 'transport-session-1',
      messageId: 'message-1',
      runId: undefined,
      name: 'background.mol'
    })
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([finalizedArtifact])
    const saveSession = vi.fn().mockResolvedValue(undefined)

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-home-molecule', kind: 'stop' }))
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-home',
        kind: 'artifact',
        runId: 'run-home',
        artifactSessionId: 'artifact-session-home',
        artifactClaimId: 'claim-home',
        artifacts: [createArtifactFile({ name: 'background.mol' })]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    expect(finalizeRunArtifacts).toHaveBeenCalledOnce()
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: undefined,
      panelState: 'collapsed',
      items: []
    })
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
    const saveSession = vi.fn().mockResolvedValue(undefined)

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-non-molecule', kind: 'stop' }))

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'artifact-event-1',
        kind: 'artifact',
        runId: 'run-1',
        artifactSessionId: 'artifact-session-1',
        artifactClaimId: 'claim-1',
        artifacts: [createArtifactFile()]
      }),
      { finalizeRunArtifacts, saveSession }
    )

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: undefined,
      panelState: 'collapsed',
      items: []
    })
  })

  describe('auto-review gate on stop event', () => {
    it('does not auto-review a turn that stopped for a durable user choice', async () => {
      const reviewerRun = vi.fn().mockResolvedValue({ started: true })
      const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId

      stubReviewerApi(reviewerRun)
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'I need your choice before I can continue.'
      })

      await applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'choice-pending',
          kind: 'tool',
          toolCallId: 'choice-tool',
          promptMessageId,
          status: 'pending',
          elicitation: {
            message: 'Choose an approach',
            state: 'pending',
            durable: {
              kind: 'agent-user-choice',
              requestId: 'choice-request',
              ...(promptMessageId ? { promptMessageId } : {})
            },
            fields: [
              {
                id: 'question_0',
                label: 'Approach',
                kind: 'single-select',
                options: [{ value: 'minimal', label: 'Minimal' }]
              }
            ]
          }
        })
      )
      await applyWorkspaceRuntimeEvent(
        createEvent({ id: 'choice-turn-stop', kind: 'stop', text: 'end_turn', promptMessageId })
      )
      await vi.runAllTimersAsync()

      expect(reviewerRun).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('cancels pending and future auto-reviews once quit begins', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      stubReviewerApi(reviewerRun)
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      suppressAutoReviewsForQuit()
      await vi.runAllTimersAsync()

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-2', kind: 'stop' }))
      await vi.runAllTimersAsync()

      expect(reviewerRun).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('allows future auto-reviews after quit preparation is aborted', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      stubReviewerApi(reviewerRun)
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })
      suppressAutoReviewsForQuit()

      resumeAutoReviewsAfterQuitAbort()
      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-after-abort', kind: 'stop' }))
      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledOnce()
      vi.unstubAllGlobals()
    })

    it('triggers a review via window.api.reviewer.run when autoReviewEnabled is true', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      stubReviewerApi(reviewerRun)

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

      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'transport-session-1' })
      )

      vi.unstubAllGlobals()
    })

    it('starts auto-review only after the completed turn is durable', async () => {
      const reviewerRun = vi.fn().mockResolvedValue({ started: true })
      let finishSave: (() => void) | undefined
      const saveSession = vi.fn(
        (session: Parameters<typeof saveSessionInOrder>[0]) =>
          new Promise<typeof session>((resolve) => {
            finishSave = () => resolve(session)
          })
      )
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }), {
        saveSession
      })
      await vi.advanceTimersByTimeAsync(100)

      expect(reviewerRun).not.toHaveBeenCalled()

      finishSave?.()
      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'transport-session-1' })
      )

      vi.unstubAllGlobals()
    })

    it('does not trigger a review when autoReviewEnabled is false', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      stubReviewerApi(reviewerRun)

      // Disable auto-review on this session.
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', false)

      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

      await vi.runAllTimersAsync()

      expect(reviewerRun).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('does not auto-review a hidden Save as skill evaluation', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      stubReviewerApi(reviewerRun)
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendUserMessage({
        sessionId: 'transport-session-1',
        content: 'Evaluate this conversation for a reusable skill.',
        turnIntent: 'save-as-skill'
      })
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-skill-evaluation',
        eventId: 'event-skill-evaluation',
        content: 'This conversation is too simple to save as a skill.'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-skill-evaluation', kind: 'stop' }))
      await vi.runAllTimersAsync()

      expect(reviewerRun).not.toHaveBeenCalled()
      expect(assembleReviewRunRequest('transport-session-1')).toBeDefined()

      vi.unstubAllGlobals()
    })

    it('does not trigger a review by default when autoReviewEnabled was never set', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      stubReviewerApi(reviewerRun)

      // No setAutoReviewEnabled call: the session keeps its default (off).
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

      await vi.runAllTimersAsync()

      expect(reviewerRun).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('re-enables a review after toggling autoReviewEnabled back to true', async () => {
      const reviewerRun = vi.fn().mockResolvedValue(undefined)

      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', false)
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)

      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))

      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'transport-session-1' })
      )

      vi.unstubAllGlobals()
    })

    it('retries a started:false auto-review so a not-yet-persisted new session still gets reviewed', async () => {
      // A brand-new session persists via an async queue; the first stop can beat the flush, so main's
      // disk load reports started:false. The auto path must retry, not silently drop the first review.
      vi.useFakeTimers()
      const reviewerRun = vi
        .fn()
        .mockResolvedValueOnce({ started: false, reason: 'not-found' }) // session not on disk yet
        .mockResolvedValueOnce({ started: true }) // flushed by the time the retry runs
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      // Drive the retry delay + the fire-and-forget promise chain to completion.
      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('does NOT retry an already-in-flight started:false (avoids launching a duplicate review)', async () => {
      // The turn is already being reviewed. If a second auto trigger sees already-in-flight and the
      // original run finishes/fails within the retry window, retrying would start a DUPLICATE review /
      // fix-loop once the lock releases. The auto path must treat already-in-flight as already handled.
      vi.useFakeTimers()
      const reviewerRun = vi
        .fn()
        .mockResolvedValueOnce({ started: false, reason: 'already-in-flight' })
        .mockResolvedValueOnce({ started: true }) // would be a DUPLICATE if wrongly retried
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      await vi.runAllTimersAsync()

      // Exactly one call: already-in-flight is non-retryable, so no duplicate is launched.
      expect(reviewerRun).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('does NOT retry a run-failed started:false (a genuine pre-push failure, not a race)', async () => {
      vi.useFakeTimers()
      const reviewerRun = vi
        .fn()
        .mockResolvedValueOnce({ started: false, reason: 'run-failed' })
        .mockResolvedValueOnce({ started: true })
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('stops retrying a persistent not-found auto-review at the attempt cap', async () => {
      // A retryable reason that never resolves (e.g. session genuinely gone): retries must be bounded.
      vi.useFakeTimers()
      const reviewerRun = vi.fn().mockResolvedValue({ started: false, reason: 'not-found' })
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      await vi.runAllTimersAsync()

      // AUTO_REVIEW_START_ATTEMPTS attempts, then it gives up.
      expect(reviewerRun).toHaveBeenCalledTimes(4)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('retries an idempotency-check-failed auto-review (main failed closed on a transient lookup)', async () => {
      vi.useFakeTimers()
      const reviewerRun = vi
        .fn()
        .mockResolvedValueOnce({ started: false, reason: 'idempotency-check-failed' }) // lookup threw
        .mockResolvedValueOnce({ started: true }) // lookup recovered, no prior review → starts
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('retries a load-failed auto-review (transient store read failure)', async () => {
      vi.useFakeTimers()
      const reviewerRun = vi
        .fn()
        .mockResolvedValueOnce({ started: false, reason: 'load-failed' }) // store read blipped
        .mockResolvedValueOnce({ started: true }) // succeeds on retry
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('stops retrying once main reports already-reviewed (another entry handled the turn)', async () => {
      // The retry-window race, resolved by main (not a renderer store check): attempt 0 gets not-found
      // and waits; during the delay another entry starts AND completes a review, releasing the in-flight
      // lock. Attempt 1 reaches main, which now sees an existing review for this turn and returns
      // already-reviewed (non-retryable) — so no duplicate review is launched.
      vi.useFakeTimers()
      const reviewerRun = vi
        .fn()
        .mockResolvedValueOnce({ started: false, reason: 'not-found' })
        .mockResolvedValueOnce({ started: false, reason: 'already-reviewed' })
        .mockResolvedValue({ started: true }) // would be a DUPLICATE if wrongly retried again
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      await vi.runAllTimersAsync()

      // Stopped at already-reviewed on attempt 1 — no third (duplicate) call.
      expect(reviewerRun).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('tags auto-review requests with origin auto so main can enforce per-turn idempotency', async () => {
      const reviewerRun = vi.fn().mockResolvedValue({ started: true })
      stubReviewerApi(reviewerRun)

      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Analysis complete'
      })

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      await vi.runAllTimersAsync()

      expect(reviewerRun).toHaveBeenCalledWith(expect.objectContaining({ origin: 'auto' }))

      vi.unstubAllGlobals()
    })

    it('waits for a post-stop artifact to finalize before starting auto-review', async () => {
      const operationOrder: string[] = []
      const reviewerRun = vi.fn().mockImplementation(async () => {
        operationOrder.push('review')
        return { started: true }
      })
      stubReviewerApi(reviewerRun)
      useSessionStore.getState().setAutoReviewEnabled('transport-session-1', true)
      const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'stream-1',
        eventId: 'event-agent-1',
        content: 'Saved the result.'
      })
      const responseMessageId = useSessionStore.getState().sessions[0].messages[1].id

      await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-1', kind: 'stop' }))
      await applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'artifact-after-stop',
          kind: 'artifact',
          runId: 'artifact-run-1',
          promptMessageId,
          artifactClaimId: 'claim-1',
          artifacts: [createArtifactFile({ runId: 'artifact-run-1' })]
        }),
        {
          saveSession: vi.fn().mockResolvedValue(undefined),
          finalizeRunArtifacts: vi.fn().mockImplementation(async () => {
            operationOrder.push('finalize')
            return [
              createArtifactFile({
                id: `transport-session-1:${responseMessageId}:result.txt`,
                sessionId: 'transport-session-1',
                messageId: responseMessageId,
                runId: undefined
              })
            ]
          })
        }
      )

      expect(reviewerRun).not.toHaveBeenCalled()
      await vi.runAllTimersAsync()

      expect(operationOrder).toEqual(['finalize', 'review'])
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
    const saveSession = vi.fn().mockResolvedValue(undefined)
    const artifactEvent = createEvent({
      id: 'artifact-event-1',
      kind: 'artifact',
      runId: 'run-1',
      artifactSessionId: 'artifact-session-1',
      artifactClaimId: 'claim-1',
      artifacts: [createArtifactFile()]
    })

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-failure', kind: 'stop' }))

    await expect(
      applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts, saveSession })
    ).rejects.toThrow('move failed')

    expect(finalizeRunArtifacts).toHaveBeenCalledOnce()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Generated file finalization failed')
    })

    await applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts, saveSession })

    const session = useSessionStore.getState().sessions[0]

    expect(finalizeRunArtifacts).toHaveBeenCalledTimes(2)
    expect(session.messages).toHaveLength(2)
    expect(session.messages[1].artifactIds).toEqual(['transport-session-1:message-1:result.txt'])
    expect(session.error).toBeUndefined()
  })

  it('does not re-finalize an artifact event that the durable Session already applied', async () => {
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
      .mockResolvedValueOnce([finalizedArtifact])
      .mockRejectedValueOnce(new Error('Artifact run claim not found: artifact-claim-expired'))
    const saveSession = vi.fn().mockResolvedValue(undefined)
    const artifactEvent = createEvent({
      id: 'artifact-event-expired-claim',
      kind: 'artifact',
      runId: 'run-expired-claim',
      artifactSessionId: 'artifact-session-1',
      artifactClaimId: 'artifact-claim-expired',
      artifacts: [createArtifactFile({ runId: 'run-expired-claim' })]
    })

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-finalize', kind: 'stop' }))
    await applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts, saveSession })
    useSessionStore
      .getState()
      .recordArtifactError(
        'transport-session-1',
        'Artifact run claim not found: artifact-claim-expired',
        true
      )
    await applyWorkspaceRuntimeEvent(artifactEvent, { finalizeRunArtifacts, saveSession })

    expect(finalizeRunArtifacts).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
  })

  it('finalizes sibling artifact events independently', async () => {
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'run-with-sibling-claims',
      eventId: 'agent-before-sibling-claims',
      content: 'Saved both results.'
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-before-sibling-claims', kind: 'stop' })
    )

    const messageId = useSessionStore.getState().sessions[0].messages[1].id
    const firstFinalizedArtifact = createArtifactFile({
      id: `transport-session-1:${messageId}:first.txt`,
      sessionId: 'transport-session-1',
      messageId,
      runId: undefined,
      name: 'first.txt',
      path: `/Users/example/.open-science/artifacts/default-project/transport-session-1/${messageId}/first.txt`
    })
    const secondFinalizedArtifact = createArtifactFile({
      id: `transport-session-1:${messageId}:second.txt`,
      sessionId: 'transport-session-1',
      messageId,
      runId: undefined,
      name: 'second.txt',
      path: `/Users/example/.open-science/artifacts/default-project/transport-session-1/${messageId}/second.txt`
    })
    const finalizeRunArtifacts = vi
      .fn()
      .mockResolvedValueOnce([firstFinalizedArtifact])
      .mockResolvedValueOnce([firstFinalizedArtifact, secondFinalizedArtifact])
    const dependencies = {
      finalizeRunArtifacts,
      saveSession: vi.fn().mockResolvedValue(undefined)
    }

    useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-with-sibling-claims',
      eventId: 'first-artifact-event',
      artifacts: [createArtifactFile({ name: 'first.txt' })]
    })
    useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-with-sibling-claims',
      eventId: 'second-artifact-event',
      artifacts: [createArtifactFile({ name: 'second.txt' })]
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'first-artifact-event',
        kind: 'artifact',
        runId: 'run-with-sibling-claims',
        artifactClaimId: 'first-claim',
        artifacts: [createArtifactFile({ name: 'first.txt' })]
      }),
      dependencies
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'second-artifact-event',
        kind: 'artifact',
        runId: 'run-with-sibling-claims',
        artifactClaimId: 'second-claim',
        artifacts: [createArtifactFile({ name: 'second.txt' })]
      }),
      dependencies
    )

    expect(finalizeRunArtifacts).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().sessions[0].messages[1].artifactIds).toEqual([
      firstFinalizedArtifact.id,
      secondFinalizedArtifact.id
    ])
  })

  it('does not treat an immutable native provenance path as finalized', async () => {
    const nativePendingArtifact = createArtifactFile({
      id: 'native-version-1',
      artifactId: 'native-artifact-1',
      versionId: 'native-version-1',
      versionNumber: 1,
      path: '/Users/example/.open-science/managed/native-version-1/result.txt'
    })
    useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-native-pending',
      eventId: 'native-pending-event',
      artifacts: [nativePendingArtifact]
    })
    useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-native-pending',
      eventId: 'unrelated-native-pending-event',
      artifacts: [
        createArtifactFile({
          id: 'unrelated-native-version',
          artifactId: 'unrelated-native-artifact',
          versionId: 'unrelated-native-version',
          name: 'unrelated.txt',
          path: '/Users/example/.open-science/managed/unrelated-native-version/unrelated.txt'
        })
      ]
    })
    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-native-replay', kind: 'stop' }))
    useSessionStore
      .getState()
      .recordArtifactError(
        'transport-session-1',
        'current claim failed',
        true,
        'native-pending-event'
      )
    const messageId = useSessionStore.getState().sessions[0].messages[1].id
    const finalizedArtifact = {
      ...nativePendingArtifact,
      messageId
    }
    const operationOrder: string[] = []
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([finalizedArtifact])
    const reconcilePendingArtifacts = vi.fn().mockImplementation(async () => {
      operationOrder.push('reconcile')
      return [finalizedArtifact]
    })
    const saveSession = vi.fn().mockImplementation(async () => {
      operationOrder.push('save')
    })

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'native-pending-event',
        kind: 'artifact',
        runId: 'run-native-pending',
        artifactClaimId: 'native-pending-claim',
        artifacts: [nativePendingArtifact]
      }),
      {
        finalizeRunArtifacts,
        reconcilePendingArtifacts,
        saveSession
      }
    )

    expect(operationOrder).toEqual(['save', 'reconcile'])
    expect(reconcilePendingArtifacts).toHaveBeenCalledOnce()
    expect(finalizeRunArtifacts).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
  })

  it('does not clear an artifact error owned by another event', async () => {
    const finalizedArtifact = createArtifactFile({
      id: 'transport-session-1:message-1:result.txt',
      sessionId: 'transport-session-1',
      messageId: 'message-1',
      runId: undefined,
      path: '/Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt'
    })
    const artifactEvent = createEvent({
      id: 'replayed-finalized-event',
      kind: 'artifact',
      runId: 'run-finalized',
      artifactClaimId: 'expired-finalized-claim',
      artifacts: [createArtifactFile({ runId: 'run-finalized' })]
    })
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([finalizedArtifact])
    const dependencies = {
      finalizeRunArtifacts,
      saveSession: vi.fn().mockResolvedValue(undefined)
    }

    await applyWorkspaceRuntimeEvent(createEvent({ id: 'stop-before-owned-error', kind: 'stop' }))
    await applyWorkspaceRuntimeEvent(artifactEvent, dependencies)
    useSessionStore
      .getState()
      .recordArtifactError(
        'transport-session-1',
        'current claim failed',
        true,
        'replayed-finalized-event'
      )
    useSessionStore
      .getState()
      .recordArtifactError(
        'transport-session-1',
        'sibling claim failed',
        true,
        'sibling-artifact-event'
      )
    useSessionStore.getState().recordArtifactError('transport-session-1', 'generic retry failed')

    await applyWorkspaceRuntimeEvent(artifactEvent, dependencies)

    expect(finalizeRunArtifacts).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0].error).toContain('generic retry failed')
    expect(useSessionStore.getState().sessions[0].artifactErrorEventIds).toEqual([
      'sibling-artifact-event'
    ])
  })

  it('records native artifact reconciliation failures for retry', async () => {
    const nativePendingArtifact = createArtifactFile({
      id: 'native-version-reconcile-failure',
      artifactId: 'native-artifact-reconcile-failure',
      versionId: 'native-version-reconcile-failure',
      versionNumber: 1,
      path: '/Users/example/.open-science/managed/native-version-reconcile-failure/result.txt'
    })
    useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-native-reconcile-failure',
      eventId: 'native-reconcile-failure-event',
      artifacts: [nativePendingArtifact]
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-before-native-reconcile-failure', kind: 'stop' })
    )

    await expect(
      applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'native-reconcile-failure-event',
          kind: 'artifact',
          runId: 'run-native-reconcile-failure',
          artifactClaimId: 'native-reconcile-failure-claim',
          artifacts: [nativePendingArtifact]
        }),
        {
          reconcilePendingArtifacts: vi.fn().mockRejectedValue(new Error('reconcile failed')),
          saveSession: vi.fn().mockResolvedValue(undefined)
        }
      )
    ).rejects.toThrow('reconcile failed')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Generated file finalization failed')
    })
  })

  it('rejects incomplete native artifact reconciliation results', async () => {
    const nativePendingArtifact = createArtifactFile({
      id: 'native-version-incomplete',
      artifactId: 'native-artifact-incomplete',
      versionId: 'native-version-incomplete',
      versionNumber: 1,
      path: '/Users/example/.open-science/managed/native-version-incomplete/result.txt'
    })
    useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-native-incomplete',
      eventId: 'native-incomplete-event',
      artifacts: [nativePendingArtifact]
    })
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-before-native-incomplete', kind: 'stop' })
    )

    await expect(
      applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'native-incomplete-event',
          kind: 'artifact',
          runId: 'run-native-incomplete',
          artifactClaimId: 'native-incomplete-claim',
          artifacts: [nativePendingArtifact]
        }),
        {
          reconcilePendingArtifacts: vi.fn().mockResolvedValue([]),
          finalizeRunArtifacts: vi
            .fn()
            .mockRejectedValue(new Error('Artifact run claim not found: native-incomplete-claim')),
          saveSession: vi.fn().mockResolvedValue(undefined)
        }
      )
    ).rejects.toThrow('Artifact reconciliation did not resolve all native Versions.')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      artifactErrorEventIds: ['native-incomplete-event']
    })
  })
})

describe('loop guard: suppressNextAutoReview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    resetDeferredArtifactEventsForTests()
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
    stubReviewerApi(reviewerRun)

    // Mark the next stop for suppression (simulates the [Auditor] correction turn).
    suppressNextAutoReview('transport-session-1')

    // First stop: suppressed (correction turn's stop).
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-correction', kind: 'stop', sessionId: 'transport-session-1' })
    )
    await vi.runAllTimersAsync()

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
    await vi.runAllTimersAsync()

    // reviewer.run called exactly once for the normal turn.
    expect(reviewerRun).toHaveBeenCalledTimes(1)
    expect(reviewerRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'transport-session-1' })
    )

    vi.unstubAllGlobals()
  })

  it('does not auto-review a Reviewer correction when the one-shot suppression event was missed', async () => {
    const reviewerRun = vi.fn().mockResolvedValue(undefined)
    stubReviewerApi(reviewerRun)

    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'reviewer-correction-prompt',
        role: 'user',
        messageId: 'reviewer-correction-prompt',
        promptMessageId: 'reviewer-correction-prompt',
        text: '[Auditor] Correct the unsupported claim.',
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review-1'
        }
      })
    )
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'reviewer-correction-response',
        role: 'assistant',
        messageId: 'reviewer-correction-response',
        promptMessageId: 'reviewer-correction-prompt',
        text: 'Corrected the unsupported claim.'
      })
    )

    // Simulate a refreshed or late-joining renderer: it has the durable correction attribution but
    // never received reviewer:suppress-next-auto-review before the correction turn stopped.
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'reviewer-correction-stop',
        kind: 'stop',
        sessionId: 'transport-session-1',
        promptMessageId: 'reviewer-correction-prompt'
      })
    )
    await vi.runAllTimersAsync()

    expect(reviewerRun).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('does not suppress a different session', async () => {
    const reviewerRun = vi.fn().mockResolvedValue(undefined)
    stubReviewerApi(reviewerRun)

    // Suppress only 'other-session'.
    suppressNextAutoReview('other-session')

    // A stop for 'transport-session-1' should still trigger auto-review.
    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-1', kind: 'stop', sessionId: 'transport-session-1' })
    )
    await vi.runAllTimersAsync()

    // transport-session-1 is not suppressed, reviewer.run fires.
    expect(reviewerRun).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })

  it('clearSuppressNextAutoReview cancels a pending suppression (correction turn failed to send)', async () => {
    const reviewerRun = vi.fn().mockResolvedValue(undefined)
    stubReviewerApi(reviewerRun)

    // A correction was about to fire (suppress set), but its sendPrompt failed — clear the flag so
    // the user's next real turn is not silently skipped.
    suppressNextAutoReview('transport-session-1')
    clearSuppressNextAutoReview('transport-session-1')

    await applyWorkspaceRuntimeEvent(
      createEvent({ id: 'stop-next', kind: 'stop', sessionId: 'transport-session-1' })
    )
    await vi.runAllTimersAsync()

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
    expect(result).not.toHaveProperty('model')
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
