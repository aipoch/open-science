// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  projectSessionActionability,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'
import type { TextAnnotation } from '../../../../shared/annotations'

import type { ComposerDoc } from './composer/composer-doc'
import {
  useWorkspaceConversationController,
  type WorkspaceConversationController,
  type WorkspaceConversationControllerOptions
} from './workspace-conversation-controller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

const quotedAnnotation = (): TextAnnotation => ({
  id: 'annotation-side-chat',
  kind: 'text',
  target: 'agent',
  quote: 'The confidence intervals overlap.',
  note: 'Explain this caveat.',
  source: { kind: 'agent-message', sessionId: 'session-a', messageId: 'agent-message-a' }
})

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-a',
  projectId: 'project-a',
  title: 'Session A',
  cwd: '/workspace/project-a',
  status: 'idle',
  permissionProfile: 'full',
  messages: [
    {
      id: 'message-user-a',
      role: 'user',
      content: 'First main prompt',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const runningSession = (): ChatSession =>
  session({
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
          headMessageId: 'message-user-a',
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

const options = (
  overrides: Partial<WorkspaceConversationControllerOptions> = {}
): WorkspaceConversationControllerOptions => {
  const doc = textDoc('hello')
  const activeSession = overrides.activeSession ?? session()
  return {
    activeSession,
    projectId: 'project-a',
    currentDraftKey: 'session-a',
    persistenceBlockedSessionIds: [],
    isPersistenceReady: true,
    supportsImageInput: true,
    agentConfiguration: {
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'medium'
    },
    agentConfigurationReady: true,
    permissionProfile: 'full',
    isReviewing: false,
    isTurnAdmissionBlocked: false,
    promptInFlightSessionIds: [],
    sendPreparationInFlightSessionIds: [],
    saveAsSkillInFlightSessionIds: [],
    actionability: projectSessionActionability(activeSession),
    hasPendingPermissionRequest: vi.fn(() => false),
    newConversationAutoReviewEnabled: false,
    newConversationEnabledComputeHosts: [],
    composer: {
      view: {
        doc,
        annotations: [],
        attachments: [],
        transfers: [],
        readingContext: {
          bindings: [],
          pendingBindingId: undefined,
          isPending: false,
          automaticAttachmentCount: 0
        }
      },
      actions: { setError: vi.fn() },
      lifecycle: {
        captureSend: vi.fn(() => ({
          draftKey: 'session-a',
          version: 1,
          doc,
          annotations: [],
          attachments: []
        })),
        captureRevision: vi.fn((revisionDoc, annotations) => ({
          draftKey: 'session-a',
          version: 1,
          doc: revisionDoc,
          annotations,
          attachments: []
        })),
        clearDraft: vi.fn(),
        restoreFailedSend: vi.fn(() => true),
        discardSnapshot: vi.fn()
      }
    },
    session: {
      view: {
        deletingIds: new Set(),
        specialist: { barrierInFlight: false, sendAvailable: true }
      },
      actions: {
        beginReconfigureRetry: vi.fn(() => true),
        resetNewConversationSpecialist: vi.fn(),
        confirmDelete: vi.fn()
      },
      lifecycle: {
        canStartSend: vi.fn(() => true),
        captureSendIntent: vi.fn(() => ({
          draftSpecialistId: undefined,
          hasPendingSwitch: false,
          pendingSpecialistId: undefined
        })),
        prepareSpecialistSend: vi.fn(() => Promise.resolve(true)),
        isBarrierInFlight: vi.fn(() => false)
      }
    },
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve({ sessionId: 'session-a', messageId: 'message-a' })),
      resendEditedMessage: vi.fn(() => Promise.resolve(true)),
      cancelRun: vi.fn(() => Promise.resolve()),
      resumeInterruptedSession: vi.fn(() => Promise.resolve()),
      ensureSessionReady: vi.fn(() => Promise.resolve())
    },
    sideChatOpen: false,
    setAutoReviewEnabled: vi.fn(),
    resetNewConversationSettings: vi.fn(),
    abortFixLoop: vi.fn(() => Promise.resolve()),
    getSession: (sessionId) => (sessionId === 'session-a' ? session() : undefined),
    subscribeSessionChanges: () => () => undefined,
    onSessionSizeLimit: vi.fn(),
    ...overrides
  }
}

type Hook = {
  result: { current: WorkspaceConversationController }
  rerender: (next: WorkspaceConversationControllerOptions) => void
  unmount: () => void
}

const renderController = (initial: WorkspaceConversationControllerOptions): Hook => {
  let current = initial
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  const result = { current: undefined as unknown as WorkspaceConversationController }
  const Harness = (): null => {
    result.current = useWorkspaceConversationController(current)
    return null
  }
  const render = (): void => act(() => root.render(createElement(Harness)))
  render()
  return {
    result,
    rerender: (next): void => {
      current = next
      render()
    },
    unmount: (): void => act(() => root.unmount())
  }
}

const mounted: Hook[] = []

afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount()
  vi.restoreAllMocks()
})

describe('workspace conversation controller', () => {
  it('admits and sends a structured annotation without message text', async () => {
    const annotation = {
      id: 'annotation-1',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'Quoted Agent response',
      source: {
        kind: 'agent-message' as const,
        sessionId: 'session-a',
        messageId: 'agent-message-a'
      }
    }
    const input = options()
    let resolveAdmission!: (value: { sessionId: string; messageId: string }) => void
    input.runtime.sendMessage = vi.fn(
      () =>
        new Promise<{ sessionId: string; messageId: string }>((resolve) => {
          resolveAdmission = resolve
        })
    )
    input.composer.view.doc = { nodes: [] }
    input.composer.view.annotations = [annotation]
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'session-a',
      version: 1,
      doc: { nodes: [] },
      annotations: [annotation],
      attachments: []
    }))
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.submit).toBe(true)
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '', annotations: [annotation] })
    )
    expect(hook.result.current.optimisticMessage).toMatchObject({
      content: '',
      annotations: [annotation]
    })
    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()

    await act(async () =>
      resolveAdmission({ sessionId: 'session-a', messageId: 'annotation-message-1' })
    )
    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 1)
  })

  it('blocks an image-point annotation before capture when the model cannot read images', () => {
    const input = options()
    const annotation = {
      id: 'point-1',
      kind: 'image-point' as const,
      target: 'agent' as const,
      note: 'Inspect this point',
      source: {
        kind: 'artifact-version' as const,
        projectId: 'project-a',
        sessionId: 'session-a',
        versionId: 'version-1',
        name: 'figure.png',
        path: 'artifact-version:project-a/session-a/artifact-1/version-1',
        mimeType: 'image/png'
      },
      point: { x: 0.5, y: 0.5 },
      naturalSize: { width: 100, height: 100 }
    }
    input.supportsImageInput = false
    input.composer.view.annotations = [annotation]
    const hook = renderController(input)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))

    expect(input.composer.actions.setError).toHaveBeenCalledWith(
      "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."
    )
    expect(input.composer.lifecycle.captureSend).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('sends an annotation-only New Conversation to the current project without a Session id', async () => {
    const annotation = {
      id: 'new-conversation-annotation',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'Quoted project evidence',
      source: {
        kind: 'project-file' as const,
        projectId: 'project-a',
        path: 'results/report.md',
        versionId: 'version-a'
      }
    }
    const input = options({
      activeSession: undefined,
      currentDraftKey: 'new:project-a'
    })
    input.composer.view.doc = { nodes: [] }
    input.composer.view.annotations = [annotation]
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'new:project-a',
      version: 3,
      doc: { nodes: [] },
      annotations: [annotation],
      attachments: []
    }))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
        projectId: 'project-a',
        text: '',
        annotations: [annotation]
      })
    )
    await vi.waitFor(() =>
      expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('new:project-a', 3)
    )
  })

  it('exposes the submitted draft immediately while runtime admission is pending', async () => {
    let resolveAdmission!: (value: { sessionId: string; messageId: string }) => void
    const admission = new Promise<{ sessionId: string; messageId: string }>((resolve) => {
      resolveAdmission = resolve
    })
    const input = options()
    input.runtime.sendMessage = vi.fn(() => admission)
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))

    expect(hook.result.current.optimisticMessage).toMatchObject({
      role: 'user',
      content: 'hello',
      parts: textDoc('hello').nodes,
      uploads: []
    })

    await act(async () => resolveAdmission({ sessionId: 'session-a', messageId: 'message-a' }))
    expect(hook.result.current.optimisticMessage).toBeUndefined()
  })

  it('branches from a completed Agent Message without consuming the composer draft', async () => {
    const input = options()
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(true)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith({
      branchSourceSessionId: 'session-a',
      branchSourceMessageId: 'agent-message-a',
      text: '',
      agentConfiguration: input.agentConfiguration,
      delegationPolicy: 'allow',
      specialistId: undefined
    })
    expect(input.composer.lifecycle.captureSend).not.toHaveBeenCalled()
    expect(input.resetNewConversationSettings).toHaveBeenCalledOnce()
    expect(input.session.actions.resetNewConversationSpecialist).toHaveBeenCalledOnce()
  })

  it('retains new-Session settings when Agent Message branching fails', async () => {
    const input = options({ newConversationDelegationPolicyOverride: 'deny' })
    input.runtime.sendMessage = vi.fn().mockRejectedValue(new Error('Branch unavailable'))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.branch('agent-message-a'))
    await vi.waitFor(() =>
      expect(input.composer.actions.setError).toHaveBeenCalledWith('Branch unavailable')
    )

    expect(input.resetNewConversationSettings).not.toHaveBeenCalled()
    expect(input.session.actions.resetNewConversationSpecialist).not.toHaveBeenCalled()
  })

  it('inherits a denied source policy when branching the current draft', async () => {
    const source = session({ delegationPolicy: 'deny' })
    const input = options({
      activeSession: source,
      actionability: projectSessionActionability(source)
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [], mode: 'branch' }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
        branchSourceSessionId: 'session-a',
        delegationPolicy: 'deny'
      })
    )
  })

  it('uses an explicit new-Session Delegation override when branching', async () => {
    const source = session({ delegationPolicy: 'allow' })
    const input = options({
      activeSession: source,
      actionability: projectSessionActionability(source),
      newConversationDelegationPolicyOverride: 'deny'
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [], mode: 'branch' }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        branchSourceSessionId: 'session-a',
        delegationPolicy: 'deny'
      })
    )
  })

  it('uses the pending Specialist intent for the branched child Session', async () => {
    const input = options()
    input.session.lifecycle.captureSendIntent = vi.fn(() => ({
      draftSpecialistId: 'specialist-b',
      hasPendingSwitch: false,
      pendingSpecialistId: 'specialist-b'
    }))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.branch('agent-message-a'))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(input.session.lifecycle.captureSendIntent).toHaveBeenCalledWith(true)
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ specialistId: 'specialist-b' })
    )
  })

  it('disables Agent Message branching while the source Session is running', () => {
    const input = options({
      activeSession: session({
        status: 'running',
        activeRun: { promptMessageId: 'message-user-a', startedAt: 2 }
      })
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(false)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('disables Agent Message branching while the source Session awaits Plan approval', () => {
    const input = options({
      activeSession: session({ status: 'waiting-plan-approval' })
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(false)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('disables Agent Message branching while the Specialist barrier is in flight', () => {
    const input = options()
    input.session.view.specialist.barrierInFlight = true
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(false)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('checks Specialist admission again before creating the branched Session', () => {
    const input = options()
    input.session.lifecycle.canStartSend = vi.fn(() => false)
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(true)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.session.lifecycle.canStartSend).toHaveBeenCalledOnce()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('disables Agent Message branching when the Specialist is not ready to send', () => {
    const input = options()
    input.session.view.specialist.sendAvailable = false
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.branch).toBe(false)
    act(() => hook.result.current.actions.branch('agent-message-a'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('submits a restored Plan approval through the human-gated Plan command', async () => {
    const pendingPlan = {
      artifactId: 'artifact-plan-a',
      artifactVersionId: 'version-plan-a',
      artifactChecksum: 'a'.repeat(64),
      originatingPromptMessageId: 'message-user-a',
      revision: 3,
      approval: 'pending',
      lifecycle: 'awaiting_approval',
      document: {
        schema_version: 1,
        task_summary: 'Analyze the dataset',
        phases: [],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      stepStatuses: {},
      stepStates: {},
      counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
    } as const
    const pendingSession = session({
      status: 'waiting-plan-approval',
      activePlanProjection: pendingPlan as never
    })
    const respondPlan = vi.fn(async () => ({ changed: true }))
    const getPlanProjection = vi.fn(async () => ({
      ...pendingPlan,
      revision: 4,
      approval: 'approved' as const,
      lifecycle: 'approved' as const
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { acp: { respondPlan, getPlanProjection } }
    })
    useSessionStore.setState({ sessions: [pendingSession] })
    const input = options({
      activeSession: pendingSession,
      getSession: (sessionId) => (sessionId === pendingSession.id ? pendingSession : undefined)
    })
    const hook = renderController(input)
    mounted.push(hook)

    await act(async () => hook.result.current.actions.submit.restoredPlan({ decision: 'approved' }))

    expect(respondPlan).toHaveBeenCalledWith({
      projectId: 'project-a',
      sessionId: 'session-a',
      artifactVersionId: 'version-plan-a',
      expectedRevision: 3,
      decision: 'approved'
    })
    expect(input.runtime.ensureSessionReady).toHaveBeenCalledWith('session-a')
    expect(input.runtime.ensureSessionReady).toHaveBeenCalledBefore(respondPlan)
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses a restored Plan response when the Session model is unavailable', async () => {
    const pendingPlan = {
      artifactId: 'artifact-plan-a',
      artifactVersionId: 'version-plan-a',
      artifactChecksum: 'a'.repeat(64),
      originatingPromptMessageId: 'message-user-a',
      revision: 3,
      approval: 'pending',
      lifecycle: 'awaiting_approval',
      document: {
        schema_version: 1,
        task_summary: 'Analyze the dataset',
        phases: [],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      stepStatuses: {},
      stepStates: {},
      counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
    } as const
    const pendingSession = session({
      status: 'waiting-plan-approval',
      activePlanProjection: pendingPlan as never
    })
    const respondPlan = vi.fn(async () => ({ changed: true }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        acp: {
          respondPlan,
          getPlanProjection: vi.fn(async () => pendingPlan)
        }
      }
    })
    useSessionStore.setState({ sessions: [pendingSession] })
    const input = options({
      activeSession: pendingSession,
      agentConfigurationReady: false,
      getSession: (sessionId) => (sessionId === pendingSession.id ? pendingSession : undefined)
    })
    const hook = renderController(input)
    mounted.push(hook)

    await expect(
      hook.result.current.actions.submit.restoredPlan({ decision: 'approved' })
    ).rejects.toThrow('The Session model is unavailable.')
    expect(input.runtime.ensureSessionReady).not.toHaveBeenCalled()
    expect(respondPlan).not.toHaveBeenCalled()
  })

  it('refuses a restored Plan response for a persistence-blocked Session', async () => {
    const pendingPlan = {
      artifactId: 'artifact-plan-a',
      artifactVersionId: 'version-plan-a',
      artifactChecksum: 'a'.repeat(64),
      originatingPromptMessageId: 'message-user-a',
      revision: 3,
      approval: 'pending' as const,
      lifecycle: 'awaiting_approval' as const,
      requiresExplicitContinuation: false,
      document: {
        schema_version: 1 as const,
        task_summary: 'Review the plan',
        phases: [],
        desired_outputs: [],
        feasibility: { confidence: 'high' as const, rationale: 'Ready.' }
      },
      stepStatuses: {},
      stepStates: {},
      counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
    }
    const pendingSession = session({
      status: 'waiting-plan-approval',
      activePlanProjection: pendingPlan as never
    })
    const respondPlan = vi.fn(async () => ({ changed: true }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { acp: { respondPlan } }
    })
    const input = options({
      activeSession: pendingSession,
      persistenceBlockedSessionIds: [pendingSession.id],
      isPersistenceReady: false,
      getSession: () => pendingSession
    })
    const hook = renderController(input)
    mounted.push(hook)

    await expect(
      hook.result.current.actions.submit.restoredPlan({ decision: 'approved' })
    ).rejects.toThrow('Session persistence is unavailable.')
    expect(input.runtime.ensureSessionReady).not.toHaveBeenCalled()
    expect(respondPlan).not.toHaveBeenCalled()
  })

  it('blocks submit and revision while waiting for a user answer', () => {
    const input = options({ activeSession: session({ status: 'waiting-for-user' }) })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({ submit: false, revise: false })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => {
      void hook.result.current.actions.revise('message-a', textDoc('changed'), [])
    })
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('keeps send and message branching available while history replay is pending', () => {
    const replaySession = session({ pendingHistoryReplay: { kind: 'all' } })
    const startSideChat = vi.fn(async () => true)
    const input = options({
      activeSession: replaySession,
      actionability: projectSessionActionability(replaySession),
      sideChat: { start: startSideChat }
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({
      submit: true,
      branch: true
    })
    act(() => hook.result.current.actions.branch('agent-message-a'))
    act(() => hook.result.current.actions.sideChat.start())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        branchSourceSessionId: 'session-a',
        branchSourceMessageId: 'agent-message-a'
      })
    )
    expect(startSideChat).not.toHaveBeenCalled()

    vi.mocked(input.runtime.sendMessage).mockClear()
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-a',
        text: 'hello',
        agentConfiguration: input.agentConfiguration
      })
    )
  })

  it('blocks submit while a selected branched Session is still binding', () => {
    const pendingSession = session({ isPending: true })
    const input = options({
      activeSession: pendingSession,
      actionability: projectSessionActionability(pendingSession)
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.submit).toBe(false)
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps the main Turn available for a delegated Permission', () => {
    const delegatedWait = session({
      status: 'waiting-permission',
      interactionState: { permission: true, elicitation: false, plan: false }
    })
    const input = options({
      activeSession: delegatedWait,
      actionability: projectSessionActionability(delegatedWait, {
        rootPermissionPending: false
      })
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({ submit: true, revise: true })
  })

  it('queues an ordinary submit during a running turn without overlapping the runtime prompt', () => {
    const running = runningSession()
    const input = options({
      activeSession: running,
      promptInFlightSessionIds: [running.id],
      getSession: () => running
    })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({
      submit: true,
      submitMode: 'queue'
    })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: ['skill-a'] }))

    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 1)
    expect(hook.result.current.queue.items).toEqual([
      expect.objectContaining({ text: 'hello', phase: 'queued' })
    ])
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('blocks sending and queueing while a Reading context mutation is pending', () => {
    const idleInput = options()
    Object.assign(idleInput.composer.view, {
      readingContext: { bindings: [], pendingBindingId: 'binding-1', isPending: true }
    })
    const idleHook = renderController(idleInput)
    mounted.push(idleHook)

    expect(idleHook.result.current.availability.submit).toBe(false)

    const running = runningSession()
    const runningInput = options({
      activeSession: running,
      promptInFlightSessionIds: [running.id],
      getSession: () => running
    })
    Object.assign(runningInput.composer.view, {
      readingContext: { bindings: [], pendingBindingId: 'binding-1', isPending: true }
    })
    const runningHook = renderController(runningInput)
    mounted.push(runningHook)

    expect(runningHook.result.current.availability.submit).toBe(false)
  })

  it('queues without dispatching while the selected Specialist is not ready', () => {
    const running = runningSession()
    const input = options({ activeSession: running, getSession: () => running })
    input.session.lifecycle.canStartSend = vi.fn(() => false)
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))

    expect(hook.result.current.queue.items).toEqual([
      expect.objectContaining({ text: 'hello', phase: 'queued' })
    ])
    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 1)
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('captures the active Session Specialist when queueing', async () => {
    let currentSession = { ...runningSession(), specialistId: 'specialist-a' }
    const input = options({ activeSession: currentSession, getSession: () => currentSession })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    currentSession = { ...currentSession, status: 'idle' }
    hook.rerender({ ...input, activeSession: currentSession, getSession: () => currentSession })

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ specialistId: 'specialist-a' })
    )
  })

  it('drains queued work after another Session becomes active', async () => {
    const queuedSession = runningSession()
    const activeSession = session({ id: 'session-b' })
    const input = options({
      activeSession: queuedSession,
      promptInFlightSessionIds: [queuedSession.id],
      getSession: (sessionId) => (sessionId === queuedSession.id ? queuedSession : activeSession)
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    const settledQueuedSession = { ...queuedSession, status: 'idle' as const }
    hook.rerender({
      ...input,
      activeSession,
      promptInFlightSessionIds: [],
      getSession: (sessionId) =>
        sessionId === queuedSession.id ? settledQueuedSession : activeSession
    })

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    expect(input.session.lifecycle.canStartSend).toHaveBeenCalledWith(queuedSession.id)
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: queuedSession.id })
    )
  })

  it('keeps queued work deferred after a Session becomes persistence-blocked', async () => {
    let queuedSession = runningSession()
    const input = options({
      activeSession: queuedSession,
      promptInFlightSessionIds: [queuedSession.id],
      getSession: () => queuedSession
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    queuedSession = { ...queuedSession, status: 'error' }
    hook.rerender({
      ...input,
      activeSession: queuedSession,
      promptInFlightSessionIds: [],
      persistenceBlockedSessionIds: [queuedSession.id],
      isPersistenceReady: false,
      getSession: () => queuedSession
    })

    await act(async () => Promise.resolve())
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.queue.items).toEqual([
      expect.objectContaining({ text: 'hello', phase: 'queued' })
    ])
  })

  it('blocks immediate submit and revision while the queued head is being admitted', async () => {
    let currentSession = runningSession()
    let resolveAdmission!: (value: { sessionId: string; messageId: string }) => void
    const admission = new Promise<{ sessionId: string; messageId: string }>((resolve) => {
      resolveAdmission = resolve
    })
    const input = options({
      activeSession: currentSession,
      promptInFlightSessionIds: [currentSession.id],
      getSession: () => currentSession
    })
    input.runtime.sendMessage = vi.fn(() => admission)
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    currentSession = { ...currentSession, status: 'idle' }
    hook.rerender({
      ...input,
      activeSession: currentSession,
      promptInFlightSessionIds: [],
      getSession: () => currentSession
    })
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(hook.result.current.availability).toMatchObject({ submit: false, revise: false })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => {
      void hook.result.current.actions.revise('message-user-a', textDoc('changed'), [])
    })
    expect(input.runtime.sendMessage).toHaveBeenCalledOnce()
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()

    await act(async () => resolveAdmission({ sessionId: 'session-a', messageId: 'queued-message' }))
  })

  it('blocks submit and revision while Save as skill owns prompt admission', () => {
    const input = options({ saveAsSkillInFlightSessionIds: ['session-a'] })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({ submit: false, revise: false })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => {
      void hook.result.current.actions.revise('message-a', textDoc('changed'), [])
    })
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('moves the captured draft into Side chat and clears only its admitted version', async () => {
    const annotation = quotedAnnotation()
    const input = options({ sideChat: { start: vi.fn(async () => true) } })
    input.composer.view.annotations = [annotation]
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'session-a',
      version: 7,
      doc: textDoc('Compare these observations.'),
      annotations: [annotation],
      attachments: []
    }))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())
    await vi.waitFor(() =>
      expect(input.sideChat?.start).toHaveBeenCalledWith(
        'Compare these observations.\n\n[Annotations]\n' +
          '{"items":[{"type":"quote","content":"The confidence intervals overlap.","instruction":"Explain this caveat."}]}'
      )
    )

    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 7)
  })

  it('starts Side chat from an annotation-only captured draft', async () => {
    const annotation = quotedAnnotation()
    const input = options({ sideChat: { start: vi.fn(async () => true) } })
    input.composer.view.doc = { nodes: [] }
    input.composer.view.annotations = [annotation]
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'session-a',
      version: 3,
      doc: { nodes: [] },
      annotations: [annotation],
      attachments: []
    }))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())

    await vi.waitFor(() =>
      expect(input.sideChat?.start).toHaveBeenCalledWith(
        '[Annotations]\n' +
          '{"items":[{"type":"quote","content":"The confidence intervals overlap.","instruction":"Explain this caveat."}]}'
      )
    )
    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 3)
  })

  it('keeps the draft when Side chat is unavailable or not admitted', async () => {
    const input = options({ sideChat: { start: vi.fn(async () => false) } })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())
    await vi.waitFor(() => expect(input.sideChat?.start).toHaveBeenCalledOnce())

    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
  })

  it('keeps the captured draft and reports the existing error when Side chat start throws', async () => {
    const input = options({
      sideChat: { start: vi.fn(async () => Promise.reject(new Error('Side chat is unavailable.'))) }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())
    await vi.waitFor(() =>
      expect(input.composer.actions.setError).toHaveBeenCalledWith('Side chat is unavailable.')
    )

    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
  })

  it('does not start Side chat for a Session without a prior main user message', () => {
    const input = options({
      activeSession: session({ messages: [] }),
      sideChat: { start: vi.fn(async () => true) }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())

    expect(input.sideChat?.start).not.toHaveBeenCalled()
    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
  })

  it.each(['waiting-for-user', 'waiting-permission', 'waiting-plan-approval'] as const)(
    'does not start Side chat while the main Session is %s',
    (status) => {
      const input = options({
        activeSession: session({ status }),
        sideChat: { start: vi.fn(async () => true) }
      })
      const hook = renderController(input)
      mounted.push(hook)

      act(() => hook.result.current.actions.sideChat.start())

      expect(input.sideChat?.start).not.toHaveBeenCalled()
      expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
    }
  )

  it('blocks main submit, revise, resume, and cancel while Side chat owns the Session', async () => {
    const input = options({ sideChatOpen: true })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => {
      void hook.result.current.actions.revise('message-user-a', textDoc('changed'), [])
    })
    await act(async () => hook.result.current.actions.resume())
    await act(async () => hook.result.current.actions.cancel())

    expect(hook.result.current.availability).toMatchObject({
      submit: false,
      revise: false,
      resume: false
    })
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
    expect(input.runtime.resumeInterruptedSession).not.toHaveBeenCalled()
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
  })

  it('orders Specialist preparation before draft clear and runtime submit', async () => {
    const order: string[] = []
    const input = options()
    input.session.lifecycle.captureSendIntent = vi.fn(() => ({
      draftSpecialistId: undefined,
      hasPendingSwitch: true,
      pendingSpecialistId: 'specialist-b'
    }))
    input.session.lifecycle.prepareSpecialistSend = vi.fn(async () => {
      order.push('barrier')
      return true
    })
    input.composer.lifecycle.clearDraft = vi.fn(() => {
      order.push('clear')
      return true
    })
    input.runtime.sendMessage = vi.fn(async () => {
      order.push('send')
      return { sessionId: 'session-a', messageId: 'message-a' }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    expect(order).toEqual(['barrier', 'clear', 'send'])
    expect(input.session.lifecycle.prepareSpecialistSend).toHaveBeenCalledWith(
      'session-a',
      'specialist-b'
    )
  })

  it('fails closed without clearing or dispatching when Specialist preparation fails', async () => {
    const input = options()
    input.session.lifecycle.captureSendIntent = vi.fn(() => ({
      draftSpecialistId: undefined,
      hasPendingSwitch: true,
      pendingSpecialistId: 'specialist-b'
    }))
    input.session.lifecycle.prepareSpecialistSend = vi.fn(() => Promise.resolve(false))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.session.lifecycle.prepareSpecialistSend).toHaveBeenCalled())

    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
    expect(input.composer.lifecycle.restoreFailedSend).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('restores the captured draft when runtime submit has no result', async () => {
    const input = options()
    input.runtime.sendMessage = vi.fn(() => Promise.resolve(undefined))
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: ['skill-a'] }))
    await vi.waitFor(() => expect(input.composer.lifecycle.restoreFailedSend).toHaveBeenCalled())

    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a')
    expect(input.composer.lifecycle.restoreFailedSend).toHaveBeenCalledWith(
      expect.objectContaining({ draftKey: 'session-a', version: 1 })
    )
    expect(hook.result.current.optimisticMessage).toBeUndefined()
  })

  it('preserves the complete image annotation draft when fixed-source preflight rejects', async () => {
    const annotation = {
      id: 'point-fixed',
      kind: 'image-point' as const,
      target: 'agent' as const,
      note: 'Inspect this fixed point.',
      source: {
        kind: 'artifact-version' as const,
        projectId: 'project-a',
        sessionId: 'session-a',
        versionId: 'version-deleted',
        name: 'figure.png',
        path: 'artifact-version:project-a/session-a/artifact-1/version-deleted',
        mimeType: 'image/png'
      },
      point: { x: 0.25, y: 0.75 },
      naturalSize: { width: 800, height: 600 }
    }
    const input = options()
    const snapshot = {
      draftKey: 'session-a',
      version: 1,
      doc: textDoc('keep this explanation'),
      annotations: [annotation],
      attachments: []
    }
    input.composer.view = { ...input.composer.view, doc: snapshot.doc, annotations: [annotation] }
    input.composer.lifecycle.captureSend = vi.fn(() => snapshot)
    input.runtime.sendMessage = vi.fn(() =>
      Promise.reject(
        new Error(
          'An annotated image is no longer available. Restore access to its fixed version or remove the annotation, then try again.'
        )
      )
    )
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() =>
      expect(input.composer.lifecycle.restoreFailedSend).toHaveBeenCalledWith(snapshot)
    )

    expect(input.composer.actions.setError).toHaveBeenCalledWith(
      expect.stringContaining('fixed version')
    )
    expect(input.composer.lifecycle.clearDraft).not.toHaveBeenCalled()
    expect(hook.result.current.optimisticMessage).toBeUndefined()
  })

  it('includes new-Session Memory and Compute intent and stamps Review after submit succeeds', async () => {
    const input = options({
      activeSession: undefined,
      currentDraftKey: 'new:project-a',
      newConversationAutoReviewEnabled: true,
      newConversationMemoryEnabled: false,
      newConversationDelegationPolicyOverride: 'deny',
      newConversationEnabledComputeHosts: ['ssh:lab', 'ssh:available'],
      newConversationSelectedComputeHosts: ['ssh:lab']
    })
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'new:project-a',
      version: 1,
      doc: textDoc('new'),
      annotations: [],
      attachments: []
    }))
    input.runtime.sendMessage = vi.fn(() =>
      Promise.resolve({ sessionId: 'pending-session', messageId: 'message-a' })
    )
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    await vi.waitFor(() => expect(input.resetNewConversationSettings).toHaveBeenCalled())

    expect(input.setAutoReviewEnabled).toHaveBeenCalledWith('pending-session', true)
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfiguration: input.agentConfiguration,
        memoryEnabled: false,
        delegationPolicy: 'deny',
        enabledComputeHosts: ['ssh:lab', 'ssh:available'],
        selectedComputeHosts: ['ssh:lab']
      })
    )
    expect(input.session.actions.resetNewConversationSpecialist).toHaveBeenCalledOnce()
  })

  it('keeps revise stable while applying the latest gate and runtime mapping', async () => {
    const input = options()
    const hook = renderController(input)
    mounted.push(hook)
    const revise = hook.result.current.actions.revise

    const blocked = options({
      ...input,
      activeSession: session({ status: 'running' }),
      actionability: projectSessionActionability(session({ status: 'running' })),
      runtime: input.runtime,
      composer: input.composer,
      session: input.session
    })
    hook.rerender(blocked)
    act(() => {
      void revise('message-a', textDoc('changed'), [])
    })
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()

    hook.rerender(input)
    act(() => {
      void revise('message-a', textDoc('changed'), [])
    })
    expect(input.runtime.resendEditedMessage).toHaveBeenCalledWith('session-a', 'message-a', {
      text: 'changed',
      annotations: [],
      parts: textDoc('changed').nodes,
      forcedSkillIds: [],
      referencedArtifacts: []
    })
    expect(hook.result.current.actions.revise).toBe(revise)
  })

  it('resends an annotation-only edit through the existing message revision seam', async () => {
    const annotations = [
      {
        id: 'quote-1',
        kind: 'text' as const,
        target: 'agent' as const,
        quote: 'Quoted evidence',
        note: 'Updated note',
        source: {
          kind: 'project-file' as const,
          projectId: 'project-a',
          path: 'results/report.md',
          versionId: 'version-1'
        }
      }
    ]
    const input = options()
    const hook = renderController(input)
    mounted.push(hook)

    let result: Awaited<ReturnType<WorkspaceConversationController['actions']['revise']>> = {
      ok: false
    }
    await act(async () => {
      result = await hook.result.current.actions.revise(
        'message-user-a',
        { nodes: [] },
        annotations
      )
    })

    expect(result).toEqual({ ok: true, disposition: 'sent' })
    expect(input.runtime.resendEditedMessage).toHaveBeenCalledWith('session-a', 'message-user-a', {
      text: '',
      annotations,
      parts: [],
      forcedSkillIds: [],
      referencedArtifacts: []
    })
  })

  it('captures an edited annotation message for the existing queue while a turn is running', async () => {
    const activeSession = runningSession()
    const input = options({
      activeSession,
      getSession: (sessionId) => (sessionId === activeSession.id ? activeSession : undefined)
    })
    const annotation = {
      id: 'queued-quote',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'Queued evidence',
      source: {
        kind: 'agent-message' as const,
        sessionId: 'session-a',
        messageId: 'agent-message-a'
      }
    }
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability.revise).toBe(true)
    await expect(
      hook.result.current.actions.revise('message-user-a', { nodes: [] }, [annotation])
    ).resolves.toEqual({ ok: true, disposition: 'queued' })

    expect(input.composer.lifecycle.captureRevision).toHaveBeenCalledWith({ nodes: [] }, [
      annotation
    ])
    expect(hook.result.current.queue.items).toEqual([
      expect.objectContaining({ text: '', attachmentCount: 0, phase: 'queued' })
    ])
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('blocks an edited image annotation when the selected model cannot read images', async () => {
    const input = options({ supportsImageInput: false })
    const hook = renderController(input)
    mounted.push(hook)
    const annotation = {
      id: 'point-1',
      kind: 'image-point' as const,
      target: 'agent' as const,
      note: 'Inspect this point.',
      source: {
        kind: 'artifact-version' as const,
        projectId: 'project-a',
        sessionId: 'session-a',
        versionId: 'version-1',
        name: 'figure.png',
        path: 'artifact-version:project-a/session-a/artifact-1/version-1',
        mimeType: 'image/png'
      },
      point: { x: 0.5, y: 0.25 },
      naturalSize: { width: 800, height: 400 }
    }

    await expect(
      hook.result.current.actions.revise('message-user-a', { nodes: [] }, [annotation])
    ).resolves.toEqual({
      ok: false,
      displayMessage:
        "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."
    })

    expect(input.composer.actions.setError).toHaveBeenCalledWith(
      "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."
    )
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('aborts an active Fix Loop before cancelling the runtime run', async () => {
    const order: string[] = []
    const input = options({ activeSession: session({ fixLoopActive: true }) })
    input.abortFixLoop = vi.fn(() => {
      order.push('review')
      return Promise.resolve()
    })
    input.runtime.cancelRun = vi.fn(() => {
      order.push('runtime')
      return Promise.resolve()
    })
    const hook = renderController(input)
    mounted.push(hook)

    await act(async () => hook.result.current.actions.cancel())

    expect(order).toEqual(['review', 'runtime'])
  })

  it('gates resume and delegates deletion to the Session transaction owner', async () => {
    const input = options({ isPersistenceReady: false })
    const hook = renderController(input)
    mounted.push(hook)

    await act(async () => hook.result.current.actions.resume())
    expect(input.runtime.resumeInterruptedSession).not.toHaveBeenCalled()

    hook.rerender({ ...input, isPersistenceReady: true })
    await act(async () => hook.result.current.actions.resume())
    act(() => hook.result.current.actions.delete())

    expect(input.runtime.resumeInterruptedSession).toHaveBeenCalledWith('session-a')
    expect(input.session.actions.confirmDelete).toHaveBeenCalledOnce()
  })
})
