// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  projectSessionActionability,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'

import type { ComposerDoc } from './composer/composer-doc'
import {
  useWorkspaceConversationController,
  type WorkspaceConversationController,
  type WorkspaceConversationControllerOptions
} from './workspace-conversation-controller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

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
    promptInFlightSessionIds: [],
    sendPreparationInFlightSessionIds: [],
    saveAsSkillInFlightSessionIds: [],
    actionability: projectSessionActionability(activeSession),
    hasPendingPermissionRequest: vi.fn(() => false),
    newConversationAutoReviewEnabled: false,
    newConversationEnabledComputeHosts: [],
    composer: {
      view: { doc, attachments: [], transfers: [] },
      actions: { setError: vi.fn() },
      lifecycle: {
        captureSend: vi.fn(() => ({
          draftKey: 'session-a',
          version: 1,
          doc,
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
      specialistId: undefined
    })
    expect(input.composer.lifecycle.captureSend).not.toHaveBeenCalled()
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
      requiresExplicitContinuation: false,
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
      requiresExplicitContinuation: false,
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
      value: { acp: { respondPlan } }
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

  it('blocks submit and revision while waiting for a user answer', () => {
    const input = options({ activeSession: session({ status: 'waiting-for-user' }) })
    const hook = renderController(input)
    mounted.push(hook)

    expect(hook.result.current.availability).toMatchObject({ submit: false, revise: false })
    act(() => hook.result.current.actions.submit.draft({ forcedSkillIds: [] }))
    act(() => hook.result.current.actions.revise('message-a', textDoc('changed')))
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
    act(() => hook.result.current.actions.revise('message-user-a', textDoc('changed')))
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
    act(() => hook.result.current.actions.revise('message-a', textDoc('changed')))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()
  })

  it('moves the captured draft into Side chat and clears only its admitted version', async () => {
    const input = options({ sideChat: { start: vi.fn(async () => true) } })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())
    await vi.waitFor(() => expect(input.sideChat?.start).toHaveBeenCalledWith('hello'))

    expect(input.composer.lifecycle.clearDraft).toHaveBeenCalledWith('session-a', 1)
  })

  it('keeps the draft when Side chat is unavailable or not admitted', async () => {
    const input = options({ sideChat: { start: vi.fn(async () => false) } })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.actions.sideChat.start())
    await vi.waitFor(() => expect(input.sideChat?.start).toHaveBeenCalledOnce())

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
    act(() => hook.result.current.actions.revise('message-user-a', textDoc('changed')))
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

  it('includes new-Session Memory and Compute intent and stamps Review after submit succeeds', async () => {
    const input = options({
      activeSession: undefined,
      currentDraftKey: 'new:project-a',
      newConversationAutoReviewEnabled: true,
      newConversationMemoryEnabled: false,
      newConversationEnabledComputeHosts: ['ssh:lab', 'ssh:available'],
      newConversationSelectedComputeHosts: ['ssh:lab']
    })
    input.composer.lifecycle.captureSend = vi.fn(() => ({
      draftKey: 'new:project-a',
      version: 1,
      doc: textDoc('new'),
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
    act(() => revise('message-a', textDoc('changed')))
    expect(input.runtime.resendEditedMessage).not.toHaveBeenCalled()

    hook.rerender(input)
    act(() => revise('message-a', textDoc('changed')))
    expect(input.runtime.resendEditedMessage).toHaveBeenCalledWith('session-a', 'message-a', {
      text: 'changed',
      parts: textDoc('changed').nodes,
      forcedSkillIds: [],
      referencedArtifacts: []
    })
    expect(hook.result.current.actions.revise).toBe(revise)
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
