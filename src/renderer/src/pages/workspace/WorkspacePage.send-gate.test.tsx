// @vitest-environment jsdom
// Pins that WorkspacePage disables sending while the active session is auto-compacting after a
// request-size overflow. ConversationPanel only renders the note; the canSendMessage gate is computed
// here, so without this a manual prompt could race the recovery resend into the same session.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialMemoryState, useMemoryStore } from '@/stores/memory-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import { createInitialReviewState, useReviewStore } from '@/stores/review-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import type { ReviewWithChecks } from '../../../../shared/reviewer'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'

import { type ComposerDoc } from './composer/composer-doc'
import {
  markWorkspaceReviewHistoryLoaded,
  setDefaultWorkspaceAgentSettings
} from './workspace-page-test-fixtures'

// Capture the ConversationPanel props the page computes, notably canSendMessage and the draft callback.
let conversationProps: Parameters<(typeof import('./ConversationPanel'))['ConversationPanel']>[0]

const runtime = vi.hoisted(() => ({
  actionError: null as string | null,
  promptInFlightSessionIds: [] as string[],
  sendPreparationInFlightSessionIds: [] as string[],
  nativeContextCompactionSessionIds: ['sess-a'] as string[],
  sendMessage: vi.fn(),
  compactContext: vi.fn(),
  ensureSessionReady: vi.fn().mockResolvedValue(undefined),
  cancelRun: vi.fn(),
  deleteRuntimeSession: vi.fn(),
  respondToPermission: vi.fn(),
  setMemoryEnabled: vi.fn()
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizableHandle: (): React.JSX.Element => <div data-testid="resize-handle" />
}))

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({
    actionError: runtime.actionError,
    pendingPermissions: [],
    promptInFlightSessionIds: runtime.promptInFlightSessionIds,
    sendPreparationInFlightSessionIds: runtime.sendPreparationInFlightSessionIds,
    nativeContextCompactionSessionIds: runtime.nativeContextCompactionSessionIds,
    sendMessage: runtime.sendMessage,
    compactContext: runtime.compactContext,
    ensureSessionReady: runtime.ensureSessionReady,
    cancelRun: runtime.cancelRun,
    deleteRuntimeSession: runtime.deleteRuntimeSession,
    respondToPermission: runtime.respondToPermission,
    setMemoryEnabled: runtime.setMemoryEnabled
  })
}))

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: (): React.JSX.Element => <aside />
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: (props: typeof conversationProps): React.JSX.Element => {
    conversationProps = props
    return <section data-testid="conversation" />
  }
}))

vi.mock('./PreviewPanel', () => ({
  PreviewPanel: (): React.JSX.Element => <div data-testid="preview-panel" />
}))

vi.mock('./EditSessionDialog', () => ({
  EditSessionDialog: (): React.JSX.Element => <div />
}))

vi.mock('./DeleteSessionDialog', () => ({
  DeleteSessionDialog: (): React.JSX.Element => <div />
}))

const { WorkspacePage } = await import('./WorkspacePage')

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession => {
  const now = Date.now()

  return {
    id: 'sess-a',
    projectId: 'proj-1',
    title: 'sess-a',
    cwd: '/workspace/proj-1',
    status: 'idle',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

const createReviewableSession = (): ChatSession =>
  createSession({
    messages: [
      {
        id: 'agent-1',
        role: 'agent',
        content: 'Analysis complete.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

const planOriginMessage: ChatSession['messages'][number] = {
  id: 'plan-origin',
  role: 'user',
  content: 'Create a plan.',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
}

const planProjection = (approval: 'pending' | 'approved', revision = 3): ActivePlanProjection => ({
  artifactId: 'plan-artifact-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  revision,
  approval,
  lifecycle: approval === 'pending' ? 'awaiting_approval' : 'approved',
  document: {
    schema_version: 1,
    task_summary: 'Analyze data',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Main Agent',
            steps: [{ title: 'Analyze', description: 'Analyze the data.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Result'],
    feasibility: { confidence: 'high', rationale: 'Ready.' }
  },
  stepStatuses: {},
  stepStates: { Analyze: { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
})

describe('WorkspacePage send gate while compacting', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setDefaultWorkspaceAgentSettings()
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useProjectStore.setState({ projects: [] })
    markWorkspaceReviewHistoryLoaded({ projectId: 'proj-1', sessionId: 'sess-a' })
    useMemoryStore.setState(createInitialMemoryState())
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession()],
      selectedSessionId: 'sess-a'
    })
    vi.clearAllMocks()
    runtime.actionError = null
    runtime.promptInFlightSessionIds = []
    runtime.sendPreparationInFlightSessionIds = []
    runtime.nativeContextCompactionSessionIds = ['sess-a']

    window.api = {
      acp: {
        getPlanProjection: vi.fn(() => Promise.resolve(null)),
        respondPlan: vi.fn(() => Promise.resolve({ changed: true }))
      },
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(() => Promise.resolve())
      },
      uploads: { deleteUpload: vi.fn() },
      reviewer: {
        run: vi.fn(() => Promise.resolve({ started: true })),
        onUpdated: vi.fn(() => vi.fn()),
        onSuppressNextAutoReview: vi.fn(() => vi.fn()),
        onFixLoopStart: vi.fn(() => vi.fn()),
        onFixLoopEnd: vi.fn(() => vi.fn()),
        abortFixLoop: vi.fn(() => Promise.resolve())
      },
      compute: { enabledHostsSet: vi.fn(() => Promise.resolve()) },
      memory: {
        snapshot: vi.fn(() =>
          Promise.resolve({ revision: 1, enabled: true, categories: [], projects: [] })
        ),
        onChanged: vi.fn(() => vi.fn())
      }
    } as never

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    vi.useRealTimers()
    container.remove()
  })

  const renderPage = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
  }

  it('disables sending while the active session is compacting, and re-enables after', async () => {
    await renderPage()

    // A non-empty draft on an idle session is normally sendable — this is the control.
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('retry this'))
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)

    // Entering the compacting recovery state must gate the composer even though the status is idle and the
    // draft is unchanged, so a manual prompt can't race the recovery resend.
    await act(async () => {
      useSessionStore.getState().beginCompaction('sess-a')
    })
    expect(conversationProps.conversation.availability.submit).toBe(false)

    // Once the replay turn starts (running) and the recovery clears the flag, sending is governed by the
    // normal status rules again. Finishing the run returns to idle with the draft still sendable.
    await act(async () => {
      useSessionStore.getState().finishRun('sess-a')
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)
  })

  it('defaults Memory off and explains the global gate when Memory is off in Settings', async () => {
    vi.mocked(window.api.memory.snapshot).mockResolvedValue({
      revision: 1,
      enabled: false,
      categories: [],
      projects: []
    })

    await renderPage()

    expect(conversationProps.agentControls).toMatchObject({
      canChangeMemory: false,
      memoryEnabled: false,
      memoryDisabledReason:
        'Memory is off in Settings. Turn it on to use Memory in this conversation.'
    })

    conversationProps.agentControls.toggleMemory?.(true)
    expect(runtime.setMemoryEnabled).not.toHaveBeenCalled()

    await act(async () => useSessionStore.getState().clearSelection())
    expect(conversationProps.agentControls).toMatchObject({
      canChangeMemory: false,
      memoryEnabled: false
    })

    runtime.sendMessage.mockResolvedValueOnce({ sessionId: 'new-session', messageId: 'message-1' })
    await act(async () => conversationProps.composer.actions.changeDoc(textDoc('start safely')))
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
      await Promise.resolve()
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ memoryEnabled: false, text: 'start safely' })
    )
  })

  it.each(['running', 'waiting-permission'] as const)(
    'keeps permission mode editable while the Session is %s',
    async (status) => {
      useSessionStore.setState({
        sessions: [createSession({ status })],
        selectedSessionId: 'sess-a'
      })

      await renderPage()

      expect(conversationProps.agentControls.canChange).toBe(false)
      expect(conversationProps.agentControls.canChangeAutoReview).toBe(false)
      expect(conversationProps.agentControls.canChangeMemory).toBe(false)
      expect(conversationProps.agentControls.canChangeSpecialist).toBe(false)
      expect(conversationProps.permissions.canChangePermissionProfile).toBe(true)
    }
  )

  it('freezes the permission profile while queued prompts retain its captured value', async () => {
    useSessionStore.setState({
      sessions: [
        createSession({
          status: 'running',
          conversationGraph: {
            schemaVersion: 1,
            rootFrameId: 'root',
            activeFrameId: 'root',
            frames: [
              {
                id: 'root',
                originBindingState: 'root',
                kind: 'root',
                status: 'running',
                activeBranchId: 'branch-a',
                createdAt: 1
              }
            ],
            branches: [
              {
                id: 'branch-a',
                agentFrameId: 'root',
                headMessageId: 'message-a',
                createdAt: 1,
                updatedAt: 1
              }
            ],
            messages: [],
            activities: [],
            activityGroups: [],
            runtimeSegments: []
          }
        })
      ],
      selectedSessionId: 'sess-a'
    })
    await renderPage()
    expect(conversationProps.permissions.canChangePermissionProfile).toBe(true)

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('queue this'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
    })

    expect(conversationProps.conversation.queue.items).toHaveLength(1)
    expect(conversationProps.permissions.canChangePermissionProfile).toBe(false)
  })

  it('gates branch and Agent controls for a hidden automatic application delivery', async () => {
    const runningSession = createSession({
      status: 'running',
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: 'root',
        activeFrameId: 'root',
        frames: [
          {
            id: 'root',
            originBindingState: 'root',
            kind: 'root',
            status: 'running',
            activeBranchId: 'branch-a',
            createdAt: 1
          }
        ],
        branches: [
          {
            id: 'branch-a',
            agentFrameId: 'root',
            headMessageId: 'message-a',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        messages: [],
        activities: [],
        activityGroups: [],
        runtimeSegments: []
      }
    })
    useSessionStore.setState({ sessions: [runningSession], selectedSessionId: 'sess-a' })
    await renderPage()
    expect(conversationProps.permissions.canChangePermissionProfile).toBe(true)

    act(() => {
      void conversationProps.conversation.admitApplicationMessage({
        session: runningSession,
        text: 'Analyze job-1.',
        attribution: {
          kind: 'application',
          feature: 'compute',
          purpose: 'job-completion-analysis',
          deliveryKey: 'compute_done:sess-a:job-1',
          jobIds: ['job-1']
        }
      })
    })

    expect(conversationProps.conversation.queue.items).toEqual([])
    expect(conversationProps.conversation.queue.hasPendingWork).toBe(true)
    expect(conversationProps.conversation.availability.branch).toBe(false)
    expect(conversationProps.permissions.canChangePermissionProfile).toBe(false)
    expect(conversationProps.agentControls.canChange).toBe(false)
  })

  it('does not query Plan authority before a newly bound Session is persisted', async () => {
    useSessionStore.setState({
      sessions: [createSession({ status: 'running' })],
      selectedSessionId: 'sess-a'
    })
    vi.mocked(window.api.acp.getPlanProjection).mockRejectedValueOnce(
      new Error('Cannot read runtime context for a missing Session.')
    )

    await renderPage()

    expect(window.api.acp.getPlanProjection).not.toHaveBeenCalled()
  })

  it('blocks overlapping actions while the Session is waiting for a user answer', async () => {
    useSessionStore.setState({
      sessions: [createSession({ status: 'waiting-for-user' })],
      selectedSessionId: 'sess-a'
    })

    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('start another request'))
    })

    expect(conversationProps.conversation.availability.submit).toBe(false)
    expect(conversationProps.conversation.availability.revise).toBe(false)
    expect(conversationProps.agentControls.canChange).toBe(false)
  })

  it('unlocks a waiting Session after main drops unreadable Plan authority', async () => {
    useSessionStore.setState({
      sessions: [createSession({ status: 'waiting-plan-approval' })],
      selectedSessionId: 'sess-a'
    })

    await renderPage()

    expect(window.api.acp.getPlanProjection).toHaveBeenCalledWith('proj-1', 'sess-a')
    expect(useSessionStore.getState().sessions[0]?.status).toBe('idle')
  })

  it('recovers a restored Plan wait after a transient authority read failure', async () => {
    vi.useFakeTimers()
    let rejectFirstProjection!: (error: Error) => void
    const firstProjection = new Promise<ActivePlanProjection | null>((_resolve, reject) => {
      rejectFirstProjection = reject
    })
    useSessionStore.setState({
      sessions: [createSession({ status: 'waiting-plan-approval' })],
      selectedSessionId: 'sess-a'
    })
    vi.mocked(window.api.acp.getPlanProjection).mockReturnValue(firstProjection)

    await renderPage()
    vi.mocked(window.api.acp.getPlanProjection).mockResolvedValue(null)
    await act(async () => {
      rejectFirstProjection(new Error('temporary projection read failure'))
      await firstProjection.catch(() => undefined)
    })

    expect(conversationProps.view.actionError).toBe('Unable to restore plan state. Retrying…')
    expect(conversationProps.view.canEditDraft).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(window.api.acp.getPlanProjection).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().sessions[0]?.status).toBe('idle')
    expect(conversationProps.view.actionError).toBeNull()
    expect(conversationProps.view.canEditDraft).toBe(true)
  })

  it('submits restored Plan-card feedback through the atomic human-gated Plan command', async () => {
    const pending = {
      ...planProjection('pending'),
      originatingPromptMessageId: planOriginMessage.id
    }
    useSessionStore.setState({
      sessions: [
        createSession({
          status: 'waiting-plan-approval',
          messages: [planOriginMessage],
          activePlanProjection: pending
        })
      ],
      selectedSessionId: 'sess-a'
    })
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'message-1' })
    await renderPage()

    await act(async () => {
      await conversationProps.conversation.actions.submit.restoredPlan({
        feedback: 'Split the analysis by cohort.'
      })
    })

    expect(window.api.acp.respondPlan).toHaveBeenCalledWith({
      projectId: 'proj-1',
      sessionId: 'sess-a',
      feedback: 'Split the analysis by cohort.'
    })
    expect(runtime.ensureSessionReady).toHaveBeenCalledWith('sess-a')
    expect(runtime.ensureSessionReady.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.api.acp.respondPlan).mock.invocationCallOrder[0]!
    )
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it.each(['approved', 'rejected'] as const)(
    'submits restored %s through the human-gated Plan command',
    async (decision) => {
      const pending = {
        ...planProjection('pending'),
        originatingPromptMessageId: planOriginMessage.id
      }
      useSessionStore.setState({
        sessions: [
          createSession({
            status: 'waiting-plan-approval',
            messages: [planOriginMessage],
            activePlanProjection: pending
          })
        ],
        selectedSessionId: 'sess-a'
      })
      runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'message-1' })
      await renderPage()

      await act(async () => {
        await conversationProps.conversation.actions.submit.restoredPlan({ decision })
      })

      expect(window.api.acp.respondPlan).toHaveBeenCalledWith({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        artifactVersionId: 'plan-version-1',
        expectedRevision: 3,
        decision
      })
      expect(runtime.sendMessage).not.toHaveBeenCalled()
    }
  )

  it('sends an approved-Plan follow-up as an ordinary Message for the Agent to interpret', async () => {
    useSessionStore.setState({
      sessions: [createSession({ activePlanProjection: planProjection('approved') })],
      selectedSessionId: 'sess-a'
    })
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'message-1' })
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('continue'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
      await Promise.resolve()
    })

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'continue'
      })
    )
    runtime.sendMessage.mockClear()
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('What is the weather?'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
      await Promise.resolve()
    })
  })

  it('sends approval language as an ordinary user Message after a Plan interaction ends', async () => {
    window.api.acp.respondPlan = vi.fn()
    const pending = planProjection('pending')
    useSessionStore.setState({
      sessions: [createSession({ status: 'idle', activePlanProjection: pending })],
      selectedSessionId: 'sess-a'
    })
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'message-1' })
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('approve and continue'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce())
    })

    expect(window.api.acp.respondPlan).not.toHaveBeenCalled()
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'approve and continue'
      })
    )
  })

  it('does not convert a plain orphaned-Plan approval Message into a UI decision', async () => {
    const pending = planProjection('pending')
    useSessionStore.setState({
      sessions: [createSession({ status: 'idle', activePlanProjection: pending })],
      selectedSessionId: 'sess-a'
    })
    window.api.acp.respondPlan = vi.fn()
    runtime.sendMessage.mockResolvedValue({ sessionId: 'sess-a', messageId: 'message-1' })
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('approve'))
    })
    await act(async () => {
      conversationProps.conversation.actions.submit.draft({ forcedSkillIds: [] })
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce())
    })

    expect(window.api.acp.respondPlan).not.toHaveBeenCalled()
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'approve' }))
  })

  it('blocks message-branch changes only while the project-scoped review is running', async () => {
    await renderPage()
    expect(conversationProps.conversation.availability.revise).toBe(true)

    const runningReview: ReviewWithChecks = {
      id: 'review-1',
      projectId: 'proj-1',
      sessionId: 'sess-a',
      turnMessageId: 'reply-1',
      scope: {
        turnMessageId: 'reply-1',
        messageBranchId: 'message-branch-1',
        blocks: [],
        artifactVersionIds: []
      },
      lifecycle: 'running',
      outcome: null,
      model: 'test-model',
      reviewerLog: [],
      createdAt: 1_000,
      updatedAt: 1_000,
      checks: []
    }

    await act(async () => {
      useReviewStore.getState().handleReviewUpdate({ review: runningReview })
    })
    expect(conversationProps.conversation.availability.revise).toBe(false)
    expect(useSessionStore.getState().sessions[0]?.branchSwitchBlocked).toBe(true)

    await act(async () => {
      useReviewStore.getState().handleReviewUpdate({
        review: {
          ...runningReview,
          lifecycle: 'complete',
          outcome: 'pass',
          updatedAt: 2_000
        }
      })
    })
    expect(conversationProps.conversation.availability.revise).toBe(true)
    expect(useSessionStore.getState().sessions[0]?.branchSwitchBlocked).not.toBe(true)
  })

  it('restores the send lock from a persisted active Fix Loop review', async () => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createReviewableSession()],
      selectedSessionId: 'sess-a'
    })
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('do not race the correction'))
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)

    const activeFixLoopReview: ReviewWithChecks = {
      id: 'review-fix-loop',
      projectId: 'proj-1',
      sessionId: 'sess-a',
      turnMessageId: 'agent-1',
      scope: {
        turnMessageId: 'agent-1',
        blocks: [],
        artifactVersionIds: []
      },
      lifecycle: 'running',
      outcome: null,
      model: 'test-model',
      reviewerLog: [],
      createdAt: 1_000,
      updatedAt: 1_000,
      checks: [
        {
          id: 'finding-1',
          reviewId: 'review-fix-loop',
          status: 'fail',
          claim: 'The answer is incorrect.',
          evidence: 'The persisted result still requires correction.',
          resolution: 'open',
          reflagCount: 0,
          sortIndex: 0
        }
      ]
    }

    await act(async () => {
      useReviewStore.getState().handleReviewUpdate({ review: activeFixLoopReview })
    })
    expect(conversationProps.conversation.availability.submit).toBe(false)

    await act(async () => {
      useReviewStore.getState().handleReviewUpdate({
        review: {
          ...activeFixLoopReview,
          lifecycle: 'complete',
          outcome: 'flagged',
          updatedAt: 2_000
        }
      })
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)
  })

  it('keeps idle turn mutations locked until review history hydration establishes no active Fix Loop', async () => {
    useReviewStore.setState(createInitialReviewState())
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createReviewableSession()],
      selectedSessionId: 'sess-a'
    })
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('wait for review history'))
    })
    expect(conversationProps.conversation.availability.submit).toBe(false)
    expect(conversationProps.conversation.availability.revise).toBe(false)
    expect(conversationProps.conversation.availability.branch).toBe(false)

    await act(async () => {
      useReviewStore.setState({ loadedReviewSessions: { 'proj-1\0sess-a': true } })
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)
    expect(conversationProps.conversation.availability.revise).toBe(true)
    expect(conversationProps.conversation.availability.branch).toBe(true)
  })

  it('keeps running turn mutations locked until review history hydration establishes no active Fix Loop', async () => {
    useReviewStore.setState(createInitialReviewState())
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [{ ...createReviewableSession(), status: 'running' }],
      selectedSessionId: 'sess-a'
    })
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('do not queue before review history'))
    })
    expect(conversationProps.conversation.availability.submit).toBe(false)
    expect(conversationProps.conversation.availability.revise).toBe(false)

    await act(async () => {
      useReviewStore.setState({ loadedReviewSessions: { 'proj-1\0sess-a': true } })
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)
    expect(conversationProps.conversation.availability.revise).toBe(true)
  })

  it('keeps sending locked when review history hydration fails', async () => {
    useReviewStore.setState({
      ...createInitialReviewState(),
      loadedReviewSessions: { 'proj-1\0sess-a': true },
      loadErrorsBySession: { 'proj-1\0sess-a': 'database unavailable' }
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createReviewableSession()],
      selectedSessionId: 'sess-a'
    })
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('wait for review retry'))
    })
    expect(conversationProps.conversation.availability.submit).toBe(false)
  })

  it('keeps manual review locked until review history hydration establishes no active Fix Loop', async () => {
    useReviewStore.setState(createInitialReviewState())
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createReviewableSession()],
      selectedSessionId: 'sess-a'
    })
    await renderPage()

    act(() => {
      conversationProps.workflows.review.request()
    })
    expect(window.api.reviewer.run).not.toHaveBeenCalled()
    expect(conversationProps.workflows.review.disabled).toBe(true)

    await act(async () => {
      useReviewStore.setState({ loadedReviewSessions: { 'proj-1\0sess-a': true } })
    })
    expect(conversationProps.workflows.review.disabled).toBe(false)
  })

  it('disables sending while the runtime owns an otherwise idle session', async () => {
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('wait for compaction'))
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)

    runtime.promptInFlightSessionIds = ['sess-a']
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
    expect(conversationProps.conversation.availability.submit).toBe(false)

    runtime.promptInFlightSessionIds = []
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
    expect(conversationProps.conversation.availability.submit).toBe(true)
  })

  it('locks draft submission and message editing while a send prepares runtime adoption', async () => {
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('wait for adoption'))
    })
    expect(conversationProps.view.canEditDraft).toBe(true)
    expect(conversationProps.conversation.availability.submit).toBe(true)
    expect(conversationProps.conversation.availability.revise).toBe(true)

    runtime.sendPreparationInFlightSessionIds = ['sess-a']
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })

    expect(conversationProps.view.canEditDraft).toBe(false)
    expect(conversationProps.conversation.availability.submit).toBe(false)
    expect(conversationProps.conversation.availability.revise).toBe(false)
    expect(conversationProps.permissions.canChangePermissionProfile).toBe(false)
  })

  it('blocks new prompts after terminal conversation graph synchronization fails', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'error',
        error: 'Conversation history could not be finalized safely.',
        conversationGraphSyncBlocked: true
      }))
    }))
    await renderPage()

    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('do not overwrite the durable graph'))
    })

    expect(conversationProps.conversation.availability.submit).toBe(false)
    expect(conversationProps.conversation.availability.revise).toBe(false)
  })

  it('keeps replay-independent Session actions available until history replay is sent', async () => {
    useSessionStore.setState({
      sessions: [
        createSession({
          pendingHistoryReplay: { kind: 'all' },
          messages: [
            {
              id: 'user-1',
              role: 'user',
              content: 'Inspect the data',
              status: 'complete',
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            },
            {
              id: 'agent-1',
              role: 'agent',
              content: 'The analysis is complete.',
              status: 'complete',
              eventIds: [],
              createdAt: 2,
              updatedAt: 2
            }
          ]
        })
      ],
      selectedSessionId: 'sess-a'
    })
    await renderPage()
    await act(async () => {
      conversationProps.composer.actions.changeDoc(textDoc('continue from this branch'))
    })

    expect(conversationProps.conversation.availability.submit).toBe(true)
    expect(conversationProps.conversation.availability.branch).toBe(true)
    expect(conversationProps.workflows.review.disabled).toBe(true)
    expect(conversationProps.workflows.saveAsSkill.disabled).toBe(true)
    expect(conversationProps.contextWindow.canCompact).toBe(false)
    expect(conversationProps.contextWindow.compactDisabledReason).toBe(
      'Send a message to reconnect this session before compacting.'
    )
    expect(conversationProps.agentControls.canChange).toBe(false)
    expect(conversationProps.agentControls.canChangeAutoReview).toBe(true)
    expect(conversationProps.agentControls.canChangeMemory).toBe(true)
    expect(conversationProps.agentControls.canChangeSpecialist).toBe(true)
    expect(conversationProps.permissions.canChangePermissionProfile).toBe(false)
    expect(conversationProps.view.sideChatDisabledReason).toBe(
      'Resolve the current Session operation first.'
    )
  })

  it('allows manual compaction only for an idle session, not an unresolved error', async () => {
    await renderPage()

    expect(conversationProps.contextWindow.canCompact).toBe(true)

    await act(async () => {
      useSessionStore.getState().failRun('sess-a', 'Keep this failure visible')
    })

    expect(conversationProps.contextWindow.canCompact).toBe(false)
    expect(conversationProps.contextWindow.compactDisabledReason).toBe(
      'Resolve the current session error before compacting.'
    )
  })

  it('keeps context compaction locked until review history hydration establishes no active Fix Loop', async () => {
    useReviewStore.setState(createInitialReviewState())
    await renderPage()

    act(() => {
      conversationProps.contextWindow.compact()
    })
    expect(runtime.compactContext).not.toHaveBeenCalled()
    expect(conversationProps.contextWindow.canCompact).toBe(false)

    await act(async () => {
      useReviewStore.setState({ loadedReviewSessions: { 'proj-1\0sess-a': true } })
    })
    expect(conversationProps.contextWindow.canCompact).toBe(true)

    act(() => {
      conversationProps.contextWindow.compact()
    })
    expect(runtime.compactContext).toHaveBeenCalledWith('sess-a')
  })

  it('surfaces restored permission retry errors without replacing the authorization card', async () => {
    runtime.actionError = 'Permission response failed'
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'waiting-permission',
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-restored',
              sessionId: session.id,
              toolCallId: 'tool-1',
              title: 'Run npm test',
              options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
            },
            originatingPromptMessageId: 'prompt-1',
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        }
      }))
    }))
    await renderPage()

    expect(conversationProps.view.actionError).toBe('Permission response failed')

    runtime.actionError = null
    await act(async () => {
      useSessionStore.getState().failRun('sess-a', 'Continuation failed')
      useSessionStore.getState().setPermissionPending('sess-a')
    })

    expect(conversationProps.view.actionError).toBe('Continuation failed')
  })

  it('surfaces a failed Memory reconfiguration for the active conversation', async () => {
    runtime.setMemoryEnabled.mockRejectedValueOnce(new Error('Memory update failed'))
    await renderPage()

    await act(async () => {
      conversationProps.agentControls.toggleMemory?.(false)
      await Promise.resolve()
    })

    expect(runtime.setMemoryEnabled).toHaveBeenCalledWith('sess-a', false)
    expect(conversationProps.view.actionError).toBe('Memory update failed')
  })

  it('locks a manual review request before the running event arrives', async () => {
    let resolveReview!: (result: { started: boolean }) => void
    const pendingReview = new Promise<{ started: boolean }>((resolve) => {
      resolveReview = resolve
    })
    vi.mocked(window.api.reviewer.run).mockReturnValueOnce(pendingReview)
    useSessionStore.setState({
      sessions: [createReviewableSession()],
      selectedSessionId: 'sess-a'
    })
    await renderPage()

    act(() => {
      conversationProps.workflows.review.request()
      conversationProps.workflows.review.request()
    })

    expect(window.api.reviewer.run).toHaveBeenCalledTimes(1)
    expect(conversationProps.workflows.review.disabled).toBe(true)
    expect(conversationProps.workflows.review.running).toBe(true)
    expect(conversationProps.conversation.availability.revise).toBe(false)
    expect(useSessionStore.getState().sessions[0]?.branchSwitchBlocked).toBe(true)

    await act(async () => {
      resolveReview({ started: true })
      await pendingReview
    })
  })

  it('surfaces a manual review that did not start and leaves it retriable', async () => {
    vi.mocked(window.api.reviewer.run).mockResolvedValueOnce({
      started: false,
      reason: 'load-failed'
    })
    useSessionStore.setState({
      sessions: [createReviewableSession()],
      selectedSessionId: 'sess-a'
    })
    await renderPage()

    await act(async () => {
      conversationProps.workflows.review.request()
      await Promise.resolve()
    })

    expect(conversationProps.view.actionError).toBe('Review could not start. Try again.')
    expect(conversationProps.workflows.review.disabled).toBe(false)
    expect(conversationProps.workflows.review.running).toBe(false)
  })

  it('surfaces a rejected manual review request and leaves it retriable', async () => {
    vi.mocked(window.api.reviewer.run).mockRejectedValueOnce(new Error('review IPC unavailable'))
    useSessionStore.setState({
      sessions: [createReviewableSession()],
      selectedSessionId: 'sess-a'
    })
    await renderPage()

    await act(async () => {
      conversationProps.workflows.review.request()
      await Promise.resolve()
    })

    expect(conversationProps.view.actionError).toBe('Review could not start. Try again.')
    expect(conversationProps.workflows.review.disabled).toBe(false)
    expect(conversationProps.workflows.review.running).toBe(false)
  })
})
