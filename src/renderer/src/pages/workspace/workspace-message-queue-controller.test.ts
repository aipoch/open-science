// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'

import { type ComposerDoc } from './composer/composer-doc'
import {
  useWorkspaceMessageQueueController,
  WorkspaceMessageQueueProvider,
  type MessageQueueAdmission,
  type WorkspaceMessageQueueController,
  type WorkspaceMessageQueueControllerOptions
} from './workspace-message-queue-controller'
import {
  isWorkspaceSpecialistBarrierInFlight,
  setWorkspaceSpecialistBarrier
} from './workspace-specialist-barrier'
import {
  isWorkspacePresentationRevealing,
  setWorkspacePresentationRevealing
} from './workspace-presentation-revealing'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

const session = (status: ChatSession['status'] = 'running'): ChatSession => ({
  id: 'session-a',
  projectId: 'project-a',
  title: 'Session A',
  cwd: '/workspace/project-a',
  status,
  permissionProfile: 'full',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root',
    activeFrameId: 'root',
    frames: [
      {
        id: 'root',
        originBindingState: 'root',
        kind: 'root',
        status: status === 'running' ? 'running' : 'completed',
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

const sessionWithPendingPermission = (
  status: ChatSession['status'] = 'waiting-permission'
): ChatSession => ({
  ...session(status),
  runtimeContext: {
    version: 1,
    revision: 1,
    permission: {
      state: 'pending',
      request: {
        requestId: 'permission-1',
        sessionId: 'session-a',
        toolCallId: 'tool-1',
        title: 'Run command',
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
      },
      originatingPromptMessageId: 'message-a',
      fingerprint: 'a'.repeat(64),
      createdAt: 1
    }
  }
})

const admission = (text: string): MessageQueueAdmission => ({
  session: session(),
  snapshot: {
    draftKey: 'session-a',
    version: 1,
    doc: textDoc(text),
    annotations: [],
    attachments: []
  },
  text,
  forcedSkillIds: [],
  permissionProfile: 'full',
  agentConfiguration: {
    providerId: 'anthropic',
    model: 'claude-sonnet-4-5',
    reasoningEffort: 'medium'
  },
  specialistId: undefined
})

const options = (
  activeSession: ChatSession,
  overrides: Partial<WorkspaceMessageQueueControllerOptions> = {}
): WorkspaceMessageQueueControllerOptions => ({
  activeSession,
  promptInFlightSessionIds: activeSession.status === 'running' ? ['session-a'] : [],
  sendPreparationInFlightSessionIds: [],
  saveAsSkillInFlightSessionIds: [],
  isSideChatOpen: vi.fn(() => false),
  composer: {
    setError: vi.fn(),
    restoreQueuedDraft: vi.fn(() => true),
    discardSnapshot: vi.fn()
  },
  runtime: {
    sendMessage: vi.fn(async () => ({ sessionId: 'session-a', messageId: 'message-sent' })),
    cancelRun: vi.fn(async () => undefined)
  },
  isBarrierInFlight: vi.fn(() => false),
  isPresentationRevealing: vi.fn(() => false),
  isSpecialistReady: vi.fn(() => true),
  isPersistenceBlocked: vi.fn(() => false),
  hasPendingPermissionRequest: vi.fn(() => false),
  isProjectActive: vi.fn(() => true),
  abortFixLoop: vi.fn(async () => undefined),
  getSession: () => activeSession,
  subscribeSessionChanges: () => () => undefined,
  ...overrides
})

type Hook = {
  result: { current: WorkspaceMessageQueueController }
  rerender: (next: WorkspaceMessageQueueControllerOptions) => void
  leaveWorkspace: () => void
  returnToWorkspace: () => void
  unmount: () => void
}

const renderController = (initial: WorkspaceMessageQueueControllerOptions): Hook => {
  let current = initial
  let workspaceOpen = true
  const root: Root = createRoot(document.createElement('div'))
  const result = { current: undefined as unknown as WorkspaceMessageQueueController }
  const Harness = (): null => {
    result.current = useWorkspaceMessageQueueController(current)
    return null
  }
  const render = (): void =>
    act(() =>
      root.render(
        createElement(
          WorkspaceMessageQueueProvider,
          null,
          workspaceOpen ? createElement(Harness) : null
        )
      )
    )
  render()
  return {
    result,
    rerender: (next): void => {
      current = next
      render()
    },
    leaveWorkspace: (): void => {
      workspaceOpen = false
      render()
    },
    returnToWorkspace: (): void => {
      workspaceOpen = true
      render()
    },
    unmount: (): void => act(() => root.unmount())
  }
}

const mounted: Hook[] = []

afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount()
  useProjectStore.setState(createInitialProjectState())
  setWorkspaceSpecialistBarrier('session-a', false)
  setWorkspacePresentationRevealing('session-a', false)
  vi.restoreAllMocks()
})

describe('workspace message queue controller', () => {
  it('retains queued messages when the Workspace unmounts for Project navigation', () => {
    const input = options(session())
    const workspace = renderController(input)
    mounted.push(workspace)

    act(() => workspace.result.current.lifecycle.enqueue(admission('keep across navigation')))
    workspace.leaveWorkspace()
    workspace.returnToWorkspace()

    expect(workspace.result.current.items.map((item) => item.text)).toEqual([
      'keep across navigation'
    ])
    expect(input.composer.discardSnapshot).not.toHaveBeenCalled()
  })

  it('drops queued messages when the application queue provider is recreated', () => {
    const input = options(session())
    const application = renderController(input)

    act(() => application.result.current.lifecycle.enqueue(admission('lost on restart')))
    application.unmount()

    const restartedApplication = renderController(input)
    mounted.push(restartedApplication)

    expect(restartedApplication.result.current.items).toEqual([])
    expect(input.composer.discardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ doc: textDoc('lost on restart') })
    )
  })

  it('continues draining queued messages while Project navigation is open', async () => {
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      }
    })
    const workspace = renderController(input)
    mounted.push(workspace)

    act(() => workspace.result.current.lifecycle.enqueue(admission('send in background')))
    workspace.leaveWorkspace()

    currentSession = session('idle')
    act(() => notifySessionChanged?.())

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    workspace.returnToWorkspace()
    await vi.waitFor(() => expect(workspace.result.current.items).toEqual([]))
    expect(workspace.result.current.lifecycle.blocksImmediateSend(currentSession.id)).toBe(false)
  })

  it('does not drain a queued message after its Project is archived', async () => {
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      isProjectActive: (projectId) =>
        useProjectStore
          .getState()
          .projects.some((project) => project.id === projectId && project.archivedAt === undefined),
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      }
    })
    const workspace = renderController(input)
    mounted.push(workspace)
    useProjectStore.setState({
      projects: [
        {
          id: 'project-a',
          name: 'Project A',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      isLoaded: true
    })

    act(() => workspace.result.current.lifecycle.enqueue(admission('do not send after archive')))
    workspace.leaveWorkspace()
    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({ ...project, archivedAt: 2 }))
    }))

    currentSession = session('idle')
    act(() => notifySessionChanged?.())
    await Promise.resolve()

    expect(input.runtime.sendMessage).not.toHaveBeenCalled()

    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({ ...project, archivedAt: undefined }))
    }))
    act(() => notifySessionChanged?.())

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
  })

  it('dispatches queued messages with the agentConfiguration captured at enqueue', async () => {
    const queuedConfiguration = {
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'medium' as const
    }
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      }
    })
    const workspace = renderController(input)
    mounted.push(workspace)

    act(() => workspace.result.current.lifecycle.enqueue(admission('queued with snapshot')))

    currentSession = {
      ...session('idle'),
      agentConfiguration: {
        providerId: 'openai',
        model: 'gpt-5',
        reasoningEffort: 'high'
      }
    }
    act(() => notifySessionChanged?.())

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'queued with snapshot',
        agentConfiguration: queuedConfiguration
      })
    )
  })

  it('dispatches the frozen annotations captured when the message was queued', async () => {
    const annotation = {
      id: 'annotation-1',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'Quoted Agent evidence',
      note: 'Explain this evidence.',
      source: {
        kind: 'agent-message' as const,
        sessionId: 'session-a',
        messageId: 'agent-message-1'
      }
    }
    let currentSession = session()
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      getSession: () => currentSession
    })
    const hook = renderController(input)
    mounted.push(hook)
    const queued = admission('queued with annotation')
    queued.snapshot.annotations = [annotation]

    act(() => hook.result.current.lifecycle.enqueue(queued))
    currentSession = session('idle')
    hook.rerender({
      ...input,
      activeSession: currentSession,
      getSession: () => currentSession
    })

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'queued with annotation',
        annotations: [annotation]
      })
    )
  })

  it('dispatches pending Reading PDF selections captured when the message was queued', async () => {
    let currentSession = session()
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      getSession: () => currentSession
    })
    const hook = renderController(input)
    mounted.push(hook)
    const queued = admission('queued with new Reading PDFs')
    queued.snapshot.pendingPdfContextAttachmentIds = ['upload-1']
    queued.snapshot.pendingPdfContextVersions = [
      {
        sourceKind: 'artifact-version',
        sourceFileId: 'artifact-1',
        sourceVersionId: 'version-1'
      }
    ]

    act(() => hook.result.current.lifecycle.enqueue(queued))
    currentSession = session('idle')
    hook.rerender({ ...input, activeSession: currentSession, getSession: () => currentSession })

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingPdfContextAttachmentIds: ['upload-1'],
        pendingPdfContextVersions: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1'
          }
        ]
      })
    )
  })

  it('dispatches a queued revision through the unified edited-message runtime seam', async () => {
    let currentSession = session()
    const resendEditedMessage = vi.fn(async () => true)
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      runtime: {
        sendMessage: vi.fn(async () => ({ sessionId: 'session-a', messageId: 'message-sent' })),
        resendEditedMessage,
        cancelRun: vi.fn(async () => undefined)
      },
      getSession: () => currentSession
    })
    const hook = renderController(input)
    mounted.push(hook)
    const queued = admission('revised prompt')
    queued.revisionMessageId = 'message-user-a'

    act(() => hook.result.current.lifecycle.enqueue(queued))
    currentSession = session('idle')
    hook.rerender({ ...input, activeSession: currentSession, getSession: () => currentSession })

    await vi.waitFor(() => expect(resendEditedMessage).toHaveBeenCalledOnce())
    expect(resendEditedMessage).toHaveBeenCalledWith('session-a', 'message-user-a', {
      text: 'revised prompt',
      annotations: [],
      referencedArtifacts: [],
      parts: [{ type: 'text', text: 'revised prompt' }],
      forcedSkillIds: []
    })
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('resumes background draining when a Specialist barrier settles', async () => {
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    setWorkspaceSpecialistBarrier(currentSession.id, true)
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      isBarrierInFlight: isWorkspaceSpecialistBarrierInFlight,
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      }
    })
    const workspace = renderController(input)
    mounted.push(workspace)

    act(() => workspace.result.current.lifecycle.enqueue(admission('send after barrier')))
    workspace.leaveWorkspace()
    currentSession = session('idle')
    act(() => notifySessionChanged?.())
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()

    act(() => setWorkspaceSpecialistBarrier(currentSession.id, false))

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
  })

  it('holds queued messages until the transcript presentation settles', async () => {
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    setWorkspacePresentationRevealing(currentSession.id, true)
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      isPresentationRevealing: isWorkspacePresentationRevealing,
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      }
    })
    const workspace = renderController(input)
    mounted.push(workspace)

    act(() => workspace.result.current.lifecycle.enqueue(admission('send after reveal')))
    currentSession = session('idle')
    act(() => notifySessionChanged?.())
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()

    act(() => setWorkspacePresentationRevealing(currentSession.id, false))

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
  })

  it('dispatches queued messages immediately when the session errored mid-reveal', async () => {
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    setWorkspacePresentationRevealing(currentSession.id, true)
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      isPresentationRevealing: isWorkspacePresentationRevealing,
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      }
    })
    const workspace = renderController(input)
    mounted.push(workspace)

    act(() => workspace.result.current.lifecycle.enqueue(admission('send despite error')))
    currentSession = session('error')
    act(() => notifySessionChanged?.())

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
  })

  it('reorders, restores for editing, and discards removed snapshots', () => {
    const input = options(session())
    const hook = renderController(input)
    mounted.push(hook)

    act(() => {
      hook.result.current.lifecycle.enqueue(admission('first'))
      hook.result.current.lifecycle.enqueue(admission('second'))
    })
    const secondId = hook.result.current.items[1].id
    act(() => hook.result.current.actions.move(secondId, 'up'))
    expect(hook.result.current.items.map((item) => item.text)).toEqual(['second', 'first'])

    act(() => hook.result.current.actions.edit(secondId))
    expect(input.composer.restoreQueuedDraft).toHaveBeenCalledWith(
      expect.objectContaining({ doc: textDoc('second') })
    )
    const remainingId = hook.result.current.items[0].id
    act(() => hook.result.current.actions.remove(remainingId))
    expect(input.composer.discardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ doc: textDoc('first') })
    )
    expect(hook.result.current.items).toEqual([])
  })

  it('places a dragged message before or after its target', () => {
    const input = options(session())
    const hook = renderController(input)
    mounted.push(hook)

    act(() => {
      hook.result.current.lifecycle.enqueue(admission('first'))
      hook.result.current.lifecycle.enqueue(admission('second'))
      hook.result.current.lifecycle.enqueue(admission('third'))
    })
    const [firstId, , thirdId] = hook.result.current.items.map((item) => item.id)

    act(() => hook.result.current.actions.moveTo(firstId, thirdId, 'after'))
    expect(hook.result.current.items.map((item) => item.text)).toEqual(['second', 'third', 'first'])

    act(() => hook.result.current.actions.moveTo(firstId, thirdId, 'before'))
    expect(hook.result.current.items.map((item) => item.text)).toEqual(['second', 'first', 'third'])
  })

  it('drains the head only after the session becomes sendable', async () => {
    let currentSession = session()
    const input = options(currentSession, { getSession: () => currentSession })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.lifecycle.enqueue(admission('next prompt')))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()

    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(hook.result.current.items).toEqual([]))
  })

  it('does not admit a second queued prompt before the first admission becomes a running turn', async () => {
    const idle = session('idle')
    const input = options(idle)
    const hook = renderController(input)
    mounted.push(hook)

    act(() => {
      hook.result.current.lifecycle.enqueue({ ...admission('first'), session: idle })
      hook.result.current.lifecycle.enqueue({ ...admission('second'), session: idle })
    })

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(hook.result.current.items.map((item) => item.text)).toEqual(['second'])
    )
  })

  it('drains the next item when an admitted turn ends in error', async () => {
    let currentSession = session('idle')
    const input = options(currentSession, { getSession: () => currentSession })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => {
      hook.result.current.lifecycle.enqueue({ ...admission('first'), session: currentSession })
      hook.result.current.lifecycle.enqueue({ ...admission('second'), session: currentSession })
    })
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(hook.result.current.items.map((item) => item.text)).toEqual(['second'])
    )

    currentSession = session('error')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(hook.result.current.items).toEqual([]))
  })

  it('pauses queued prompts while the session is archived', async () => {
    let currentSession = session('idle')
    const input = options(currentSession, { getSession: () => currentSession })
    const hook = renderController(input)
    mounted.push(hook)

    currentSession = { ...currentSession, archivedAt: 2 }
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        getSession: () => currentSession
      })
    )
    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('after restore'),
        session: currentSession
      })
    )
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()

    currentSession = { ...currentSession, archivedAt: undefined }
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(hook.result.current.items).toEqual([]))
  })

  it('holds a queued prompt when overlapping idle admission loses the live turn', async () => {
    let currentSession = session('idle')
    let finishAdmission!: (result: undefined) => void
    const sendMessage = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finishAdmission = resolve
        })
    )
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage
      }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() =>
      hook.result.current.lifecycle.enqueue({ ...admission('keep me'), session: currentSession })
    )
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())

    currentSession = session()
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        getSession: () => currentSession
      })
    )
    await act(async () => {
      finishAdmission(undefined)
    })

    expect(hook.result.current.items[0]).toMatchObject({
      text: 'keep me',
      phase: 'queued',
      deferredUntilIdle: true
    })
  })

  it('retains a queued prompt when runtime admission fails', async () => {
    const idle = session('idle')
    const input = options(idle, {
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined)
      }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.lifecycle.enqueue({ ...admission('retry me'), session: idle }))

    await vi.waitFor(() =>
      expect(hook.result.current.items[0]).toMatchObject({
        text: 'retry me',
        phase: 'error',
        error: { kind: 'send' }
      })
    )
  })

  it('surfaces a resume failure after Send now of a queued attachment when the live turn ends during inject', async () => {
    const resumeError = 'Agent session resume failed: reply was never sent'
    const attachment = {
      id: 'upload-1',
      sessionId: 'session-a',
      name: 'data.csv',
      originalName: 'data.csv',
      path: '/tmp/data.csv',
      mimeType: 'text/csv',
      size: 12
    }
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    let finishSteer!: (result: { injected: false; reason: 'not-advertised' }) => void
    const sendMessage = vi.fn(async () => {
      currentSession = {
        ...session('error'),
        error: resumeError,
        errorReportable: true,
        updatedAt: currentSession.updatedAt + 1
      }
      return undefined
    })
    const steerFollowUp = vi.fn(
      () =>
        new Promise<{ injected: false; reason: 'not-advertised' }>((resolve) => {
          finishSteer = resolve
        })
    )
    const input = options(currentSession, {
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      },
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage,
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('Draw a pie chart'),
        snapshot: {
          draftKey: 'session-a',
          version: 1,
          doc: textDoc('Draw a pie chart'),
          annotations: [],
          attachments: [attachment]
        }
      })
    )
    expect(sendMessage).not.toHaveBeenCalled()

    let sendNow!: Promise<void>
    act(() => {
      sendNow = hook.result.current.actions.sendNow(hook.result.current.items[0].id)
    })
    await vi.waitFor(() => expect(steerFollowUp).toHaveBeenCalledOnce())
    expect(steerFollowUp).toHaveBeenCalledWith({
      sessionId: 'session-a',
      text: 'Draw a pie chart',
      attachments: [attachment],
      parts: textDoc('Draw a pie chart').nodes
    })

    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession,
        subscribeSessionChanges: input.subscribeSessionChanges,
        runtime: input.runtime
      })
    )
    act(() => notifySessionChanged?.())

    await act(async () => {
      finishSteer({ injected: false, reason: 'not-advertised' })
      await sendNow
    })

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Draw a pie chart',
        attachments: [attachment]
      })
    )
    await vi.waitFor(() =>
      expect(hook.result.current.items[0]).toMatchObject({
        text: 'Draw a pie chart',
        attachmentCount: 1,
        phase: 'error',
        error: { kind: 'send', detail: resumeError }
      })
    )
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    expect(hook.result.current.items[0]).toMatchObject({
      text: 'Draw a pie chart',
      attachmentCount: 1,
      phase: 'error',
      error: { kind: 'send', detail: resumeError }
    })
  })

  it('surfaces a resume failure after Send now of a queued attachment when native follow-up never replies', async () => {
    const resumeError = 'Agent session resume failed: reply was never sent'
    const attachment = {
      id: 'upload-1',
      sessionId: 'session-a',
      name: 'data.csv',
      originalName: 'data.csv',
      path: '/tmp/data.csv',
      mimeType: 'text/csv',
      size: 12
    }
    let currentSession = session()
    const sendMessage = vi.fn(async () => {
      currentSession = {
        ...session('error'),
        error: resumeError,
        errorReportable: true,
        updatedAt: currentSession.updatedAt + 1
      }
      return undefined
    })
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage,
        steerFollowUp: vi.fn(async () => {
          throw new Error("Error invoking remote method 'acp:steerFollowUp': reply was never sent")
        })
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('Draw a pie chart'),
        snapshot: {
          draftKey: 'session-a',
          version: 1,
          doc: textDoc('Draw a pie chart'),
          annotations: [],
          attachments: [attachment]
        }
      })
    )

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    currentSession = session('idle')
    act(() => {
      hook.rerender(
        options(currentSession, {
          ...input,
          activeSession: currentSession,
          promptInFlightSessionIds: [],
          getSession: () => currentSession,
          runtime: input.runtime
        })
      )
    })

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(hook.result.current.items[0]).toMatchObject({
        text: 'Draw a pie chart',
        attachmentCount: 1,
        phase: 'error',
        error: { kind: 'send', detail: resumeError }
      })
    )
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
  })

  it('keeps a generic admission miss when Send now fails without a new session error', async () => {
    const staleError = 'Agent session resume failed: reply was never sent'
    const attachment = {
      id: 'upload-1',
      sessionId: 'session-a',
      name: 'data.csv',
      originalName: 'data.csv',
      path: '/tmp/data.csv',
      mimeType: 'text/csv',
      size: 12
    }
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    let finishSteer!: (result: { injected: false; reason: 'not-advertised' }) => void
    const sendMessage = vi.fn(async () => undefined)
    const steerFollowUp = vi.fn(
      () =>
        new Promise<{ injected: false; reason: 'not-advertised' }>((resolve) => {
          finishSteer = resolve
        })
    )
    const input = options(currentSession, {
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      },
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage,
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('Draw a pie chart'),
        snapshot: {
          draftKey: 'session-a',
          version: 1,
          doc: textDoc('Draw a pie chart'),
          annotations: [],
          attachments: [attachment]
        }
      })
    )

    let sendNow!: Promise<void>
    act(() => {
      sendNow = hook.result.current.actions.sendNow(hook.result.current.items[0].id)
    })
    await vi.waitFor(() => expect(steerFollowUp).toHaveBeenCalledOnce())

    currentSession = { ...session('error'), error: staleError, errorReportable: true, updatedAt: 1 }
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession,
        subscribeSessionChanges: input.subscribeSessionChanges,
        runtime: input.runtime
      })
    )
    act(() => notifySessionChanged?.())

    await act(async () => {
      finishSteer({ injected: false, reason: 'not-advertised' })
      await sendNow
    })

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(hook.result.current.items[0]).toMatchObject({
        text: 'Draw a pie chart',
        attachmentCount: 1,
        phase: 'error',
        error: { kind: 'send', detail: 'The queued message was not admitted.' }
      })
    )
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
  })

  it('pauses dispatch while a permission request is pending', async () => {
    const idle = session('idle')
    let permissionPending = true
    const input = options(idle, {
      hasPendingPermissionRequest: () => permissionPending
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.lifecycle.enqueue({ ...admission('wait'), session: idle }))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()

    permissionPending = false
    hook.rerender(options(idle, { ...input, hasPendingPermissionRequest: () => permissionPending }))

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
  })

  it('keeps a queued prompt blocked while a durable permission response is in flight', async () => {
    const pendingPermissionSession = sessionWithPendingPermission('error')
    const input = options(pendingPermissionSession, {
      // The approval card is hidden optimistically as soon as the user responds. The durable
      // Session authority remains pending until Main settles that response.
      hasPendingPermissionRequest: () => false
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('wait for approval'),
        session: pendingPermissionSession
      })
    )

    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.items).toEqual([
      expect.objectContaining({ text: 'wait for approval', phase: 'queued' })
    ])
  })

  it('pauses dispatch until the captured Specialist is ready', async () => {
    const idle = session('idle')
    let specialistReady = false
    const input = options(idle, { isSpecialistReady: () => specialistReady })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.lifecycle.enqueue({ ...admission('wait'), session: idle }))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()

    specialistReady = true
    hook.rerender(options(idle, { ...input, isSpecialistReady: () => specialistReady }))
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
  })

  it('retains a queued prompt when its captured Specialist changes', async () => {
    const running = session('running')
    let currentSession = running
    const input = options(running, { getSession: () => currentSession })
    const hook = renderController(input)
    mounted.push(hook)

    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('stay bound'),
        session: running,
        specialistId: undefined
      })
    )
    currentSession = { ...running, status: 'idle', specialistId: 'specialist-b' }
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )

    await vi.waitFor(() => expect(hook.result.current.items[0].phase).toBe('error'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('retains a queued prompt when its captured permission profile changes', async () => {
    const running = { ...session('running'), permissionProfile: 'full' as const }
    let currentSession: ChatSession = running
    const input = options(running, { getSession: () => currentSession })
    const hook = renderController(input)
    mounted.push(hook)

    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('keep permissions'),
        session: running,
        permissionProfile: 'full'
      })
    )
    currentSession = { ...running, status: 'idle', permissionProfile: 'auto' }
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )

    await vi.waitFor(() => expect(hook.result.current.items[0].phase).toBe('error'))
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('discards remaining snapshots when a settled dispatch loses its Session', async () => {
    const idle = session('idle')
    let currentSession: ChatSession | undefined = idle
    const input = options(idle, { getSession: () => currentSession })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => {
      hook.result.current.lifecycle.enqueue({ ...admission('first'), session: idle })
      hook.result.current.lifecycle.enqueue({ ...admission('second'), session: idle })
    })
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(hook.result.current.items.map((item) => item.text)).toEqual(['second'])
    )

    currentSession = undefined
    hook.rerender(options(idle, { ...input, getSession: () => currentSession }))

    await vi.waitFor(() => expect(hook.result.current.items).toEqual([]))
    expect(input.composer.discardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ doc: textDoc('second') })
    )
  })

  it('discards snapshots after an in-flight dispatch settles for a deleted Session', async () => {
    const idle = session('idle')
    let currentSession: ChatSession | undefined = idle
    let rejectSend!: (error: Error) => void
    const input = options(idle, {
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(
          () =>
            new Promise<never>((_, reject) => {
              rejectSend = reject
            })
        )
      }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => {
      hook.result.current.lifecycle.enqueue({ ...admission('first'), session: idle })
      hook.result.current.lifecycle.enqueue({ ...admission('second'), session: idle })
    })
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())

    currentSession = undefined
    hook.rerender(options(idle, { ...input, getSession: () => currentSession }))
    expect(input.composer.discardSnapshot).not.toHaveBeenCalled()

    await act(async () => rejectSend(new Error('Session deleted')))
    await vi.waitFor(() => expect(hook.result.current.items).toEqual([]))
    expect(input.composer.discardSnapshot).toHaveBeenCalledTimes(2)
  })

  it('keeps Send now queued until the current run finishes when native follow-up is unavailable', async () => {
    const order: string[] = []
    let currentSession = session()
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => {
          order.push('cancel')
          currentSession = session('idle')
        }),
        sendMessage: vi.fn(async () => {
          order.push('send')
          return { sessionId: 'session-a', messageId: 'message-sent' }
        })
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.lifecycle.enqueue(admission('wait')))

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    expect(order).toEqual([])
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(hook.result.current.items[0]).toMatchObject({
      text: 'wait',
      phase: 'queued',
      deferredUntilIdle: true
    })
    expect(hook.result.current.announcement).toBe(
      'Queued message will send after the current run finishes.'
    )

    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(order).toEqual(['send']))
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
  })

  it('keeps Send now queued while a durable permission response is in flight', async () => {
    const pendingPermissionSession = sessionWithPendingPermission()
    const steerFollowUp = vi.fn(async () => ({
      injected: true as const,
      transport: 'acp-steering' as const,
      messageId: 'message-steer'
    }))
    const input = options(pendingPermissionSession, {
      getSession: () => pendingPermissionSession,
      hasPendingPermissionRequest: () => false,
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(),
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('wait for approval'),
        session: pendingPermissionSession
      })
    )

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))

    expect(steerFollowUp).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.items[0]).toMatchObject({
      text: 'wait for approval',
      phase: 'queued',
      deferredUntilIdle: true
    })
  })

  it('serializes Send now behind an in-flight admission', async () => {
    let currentSession = session('idle')
    const completions: Array<() => void> = []
    const sendMessage = vi.fn(
      () =>
        new Promise<{ sessionId: string; messageId: string }>((resolve) => {
          completions.push(() => resolve({ sessionId: 'session-a', messageId: 'message-sent' }))
        })
    )
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => {
          currentSession = session('idle')
        }),
        sendMessage
      }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() =>
      hook.result.current.lifecycle.enqueue({ ...admission('first'), session: currentSession })
    )
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    act(() =>
      hook.result.current.lifecycle.enqueue({ ...admission('second'), session: currentSession })
    )

    const secondId = hook.result.current.items[1].id
    let sendNow!: Promise<void>
    act(() => {
      sendNow = hook.result.current.actions.sendNow(secondId)
    })
    expect(sendMessage).toHaveBeenCalledOnce()

    currentSession = session('running')
    await act(async () => {
      completions[0]()
      await sendNow
    })
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(hook.result.current.items.map((item) => item.text)).toEqual(['second'])
    expect(hook.result.current.items[0]?.phase).toBe('queued')

    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    await act(async () => completions[1]())
    await vi.waitFor(() => expect(hook.result.current.items).toEqual([]))
  })

  it('does not cancel the current run when native follow-up is unavailable', async () => {
    const input = options(session(), {
      runtime: {
        cancelRun: vi.fn(async () => {
          throw new Error('runtime refused cancellation')
        }),
        sendMessage: vi.fn()
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.lifecycle.enqueue(admission('keep me')))

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))

    expect(hook.result.current.items).toHaveLength(1)
    expect(hook.result.current.items[0]).toMatchObject({
      text: 'keep me',
      phase: 'queued',
      deferredUntilIdle: true
    })
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects Send now when the queued item no longer matches the live session', async () => {
    let currentSession = session()
    const steerFollowUp = vi.fn(async () => ({
      injected: true as const,
      transport: 'acp-steering' as const,
      messageId: 'message-steer'
    }))
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(),
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.lifecycle.enqueue(admission('steer me')))

    currentSession = { ...currentSession, specialistId: 'specialist-b' }
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        getSession: () => currentSession
      })
    )

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    expect(steerFollowUp).not.toHaveBeenCalled()
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(hook.result.current.items[0]).toMatchObject({
      text: 'steer me',
      phase: 'error',
      error: { kind: 'send' }
    })
  })

  it('claims Send now before waiting so a second click cannot inject twice', async () => {
    const completions: Array<() => void> = []
    const sendMessage = vi.fn(
      () =>
        new Promise<{ sessionId: string; messageId: string }>((resolve) => {
          completions.push(() => resolve({ sessionId: 'session-a', messageId: 'message-sent' }))
        })
    )
    const steerFollowUp = vi.fn(async () => ({
      injected: true as const,
      transport: 'acp-steering' as const,
      messageId: 'message-steer'
    }))
    let currentSession = session('idle')
    const input = options(currentSession, {
      promptInFlightSessionIds: [],
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage,
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() =>
      hook.result.current.lifecycle.enqueue({ ...admission('first'), session: currentSession })
    )
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    act(() =>
      hook.result.current.lifecycle.enqueue({ ...admission('second'), session: currentSession })
    )

    const secondId = hook.result.current.items[1].id
    let firstSendNow!: Promise<void>
    let secondSendNow!: Promise<void>
    act(() => {
      firstSendNow = hook.result.current.actions.sendNow(secondId)
    })
    expect(hook.result.current.items[0]).toMatchObject({ text: 'second', phase: 'sending' })
    act(() => {
      secondSendNow = hook.result.current.actions.sendNow(secondId)
    })

    currentSession = session()
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        getSession: () => currentSession
      })
    )
    await act(async () => {
      completions[0]()
      await firstSendNow
      await secondSendNow
    })
    expect(steerFollowUp).toHaveBeenCalledOnce()
    expect(hook.result.current.items).toEqual([])
  })

  it('injects Send now through native follow-up without interrupting', async () => {
    const steerFollowUp = vi.fn(async () => ({
      injected: true as const,
      transport: 'acp-steering' as const,
      messageId: 'message-steer'
    }))
    const input = options(session(), {
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(),
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.lifecycle.enqueue(admission('steer me')))

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))

    expect(steerFollowUp).toHaveBeenCalledWith({
      sessionId: 'session-a',
      text: 'steer me',
      parts: textDoc('steer me').nodes
    })
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.composer.discardSnapshot).not.toHaveBeenCalled()
    expect(hook.result.current.items).toEqual([])
  })

  it('defers annotation Send now until idle instead of losing structured context in steering', async () => {
    const steerFollowUp = vi.fn()
    const input = options(session(), {
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(),
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    const queued = admission('')
    queued.snapshot.annotations = [
      {
        id: 'annotation-1',
        kind: 'text',
        target: 'agent',
        quote: 'Quoted Agent evidence',
        source: {
          kind: 'agent-message',
          sessionId: 'session-a',
          messageId: 'agent-message-1'
        }
      }
    ]
    act(() => hook.result.current.lifecycle.enqueue(queued))

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))

    expect(steerFollowUp).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.items).toEqual([
      expect.objectContaining({ phase: 'queued', deferredUntilIdle: true })
    ])
  })

  it('defers a queued PDF snapshot until idle instead of steering mutable context mid-turn', async () => {
    const steerFollowUp = vi.fn(async () => ({
      injected: true as const,
      transport: 'acp-steering' as const,
      messageId: 'message-steer'
    }))
    const input = options(session(), {
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(),
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    const queued = admission('read this paper')
    queued.snapshot.pdfContext = {
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId: 'binding-1',
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'source-session-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ]
    }
    act(() => hook.result.current.lifecycle.enqueue(queued))

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))

    expect(steerFollowUp).not.toHaveBeenCalled()
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(hook.result.current.items[0]).toMatchObject({
      phase: 'queued',
      deferredUntilIdle: true
    })
  })

  it('defers pending Reading PDF selections until their normal send path can link them', async () => {
    let currentSession = session()
    const steerFollowUp = vi.fn(async () => ({
      injected: true as const,
      transport: 'acp-steering' as const,
      messageId: 'message-steer'
    }))
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => ({
          sessionId: 'session-a',
          messageId: 'message-sent'
        })),
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    const queued = admission('read these papers')
    queued.snapshot.pendingPdfContextAttachmentIds = ['upload-1']
    queued.snapshot.pendingPdfContextVersions = [
      {
        sourceKind: 'artifact-version',
        sourceFileId: 'artifact-1',
        sourceVersionId: 'version-1'
      }
    ]
    act(() => hook.result.current.lifecycle.enqueue(queued))

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))

    expect(steerFollowUp).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.items[0]).toMatchObject({
      phase: 'queued',
      deferredUntilIdle: true
    })

    currentSession = session('idle')
    hook.rerender({
      ...input,
      activeSession: currentSession,
      getSession: () => currentSession,
      promptInFlightSessionIds: []
    })

    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
    expect(input.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingPdfContextAttachmentIds: ['upload-1'],
        pendingPdfContextVersions: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1'
          }
        ]
      })
    )
  })

  it('requeues when native follow-up is refused instead of interrupting', async () => {
    let currentSession = session()
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => {
          currentSession = session('idle')
        }),
        sendMessage: vi.fn(async () => ({ sessionId: 'session-a', messageId: 'message-sent' })),
        steerFollowUp: vi.fn(async () => ({
          injected: false as const,
          reason: 'not-advertised' as const
        }))
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.lifecycle.enqueue(admission('fallback')))

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.items[0]).toMatchObject({
      text: 'fallback',
      phase: 'queued',
      deferredUntilIdle: true
    })

    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(input.runtime.sendMessage).toHaveBeenCalledOnce())
  })

  it('drains after native follow-up refusal when the run finished during inject', async () => {
    let currentSession = session()
    let notifySessionChanged: (() => void) | undefined
    let finishSteer!: (result: { injected: false; reason: 'not-advertised' }) => void
    const sendMessage = vi.fn(async () => ({ sessionId: 'session-a', messageId: 'message-sent' }))
    const steerFollowUp = vi.fn(
      () =>
        new Promise<{ injected: false; reason: 'not-advertised' }>((resolve) => {
          finishSteer = resolve
        })
    )
    const input = options(currentSession, {
      getSession: () => currentSession,
      subscribeSessionChanges: (listener) => {
        notifySessionChanged = listener
        return () => {
          notifySessionChanged = undefined
        }
      },
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage,
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.lifecycle.enqueue(admission('late drain')))

    let sendNow!: Promise<void>
    act(() => {
      sendNow = hook.result.current.actions.sendNow(hook.result.current.items[0].id)
    })
    await vi.waitFor(() => expect(steerFollowUp).toHaveBeenCalledOnce())
    expect(hook.result.current.items[0]).toMatchObject({ text: 'late drain', phase: 'sending' })

    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession,
        subscribeSessionChanges: input.subscribeSessionChanges,
        runtime: input.runtime
      })
    )
    act(() => notifySessionChanged?.())
    expect(sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.items[0].phase).toBe('sending')

    await act(async () => {
      finishSteer({ injected: false, reason: 'not-advertised' })
      await sendNow
    })

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(hook.result.current.items).toEqual([]))
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
  })

  it('injects a queued item with attachments through native follow-up', async () => {
    const attachment = {
      id: 'upload-1',
      sessionId: 'session-a',
      name: 'notes.md',
      originalName: 'notes.md',
      path: '/tmp/notes.md',
      mimeType: 'text/markdown',
      size: 12
    }
    const steerFollowUp = vi.fn(async () => ({
      injected: true as const,
      transport: 'acp-steering' as const,
      messageId: 'message-steer'
    }))
    const input = options(session(), {
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(),
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('with file'),
        snapshot: {
          draftKey: 'session-a',
          version: 1,
          doc: textDoc('with file'),
          annotations: [],
          attachments: [attachment]
        }
      })
    )

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    expect(steerFollowUp).toHaveBeenCalledWith({
      sessionId: 'session-a',
      text: 'with file',
      attachments: [attachment],
      parts: textDoc('with file').nodes
    })
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.items).toEqual([])
  })

  it('injects a queued item with forced Skills through native follow-up', async () => {
    const steerFollowUp = vi.fn(async () => ({
      injected: true as const,
      transport: 'acp-steering' as const,
      messageId: 'message-steer'
    }))
    const input = options(session(), {
      runtime: {
        cancelRun: vi.fn(async () => undefined),
        sendMessage: vi.fn(),
        steerFollowUp
      }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() =>
      hook.result.current.lifecycle.enqueue({
        ...admission('use research'),
        forcedSkillIds: ['research']
      })
    )

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    expect(steerFollowUp).toHaveBeenCalledWith({
      sessionId: 'session-a',
      text: 'use research',
      forcedSkillIds: ['research'],
      parts: textDoc('use research').nodes
    })
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(hook.result.current.items).toEqual([])
  })

  it('admits automatic Compute analysis behind an earlier queued user Message', async () => {
    let currentSession = session('running')
    const sendMessage = vi.fn(async (input: { attribution?: { feature?: string } }) => {
      currentSession = session('running')
      return {
        sessionId: 'session-a',
        messageId: input.attribution ? 'compute-message' : 'user-message'
      }
    })
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: { cancelRun: vi.fn(async () => undefined), sendMessage }
    })
    const hook = renderController(input)
    mounted.push(hook)
    act(() => hook.result.current.lifecycle.enqueue(admission('user queued first')))

    let automatic!: Promise<{ sessionId: string; messageId: string } | undefined>
    act(() => {
      automatic = hook.result.current.lifecycle.enqueueApplication({
        session: currentSession,
        text: 'Analyze job-1.',
        attribution: {
          kind: 'application',
          feature: 'compute',
          purpose: 'job-completion-analysis',
          deliveryKey: 'compute_done:session-a:job-1',
          jobIds: ['job-1']
        }
      })
    })
    expect(hook.result.current.items.map((item) => item.text)).toEqual(['user queued first'])
    expect(hook.result.current.hasPendingWork).toBe(true)

    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0]?.[0].attribution).toBeUndefined()

    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: ['session-a'],
        getSession: () => currentSession
      })
    )
    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    await expect(automatic).resolves.toEqual({
      sessionId: 'session-a',
      messageId: 'compute-message'
    })
    expect(sendMessage.mock.calls[1]?.[0]).toMatchObject({
      attribution: { deliveryKey: 'compute_done:session-a:job-1' },
      requireExistingSession: true
    })
  })

  it('holds automatic Compute analysis behind an active turn and admits it once', async () => {
    let currentSession = session('running')
    const sendMessage = vi.fn(async () => ({
      sessionId: 'session-a',
      messageId: 'compute-message'
    }))
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: { cancelRun: vi.fn(async () => undefined), sendMessage }
    })
    const hook = renderController(input)
    mounted.push(hook)

    const completion = hook.result.current.lifecycle.enqueueApplication({
      session: currentSession,
      text: 'Analyze job-1.',
      attribution: {
        kind: 'application',
        feature: 'compute',
        purpose: 'job-completion-analysis',
        deliveryKey: 'compute_done:session-a:job-1',
        jobIds: ['job-1']
      }
    })

    await Promise.resolve()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.hasPendingWork).toBe(true)

    currentSession = session('idle')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )

    await expect(completion).resolves.toEqual({
      sessionId: 'session-a',
      messageId: 'compute-message'
    })
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it('rejects an automatic delivery when its bound Message Branch changes before dispatch', async () => {
    let currentSession = session('running')
    const sendMessage = vi.fn(async () => ({
      sessionId: 'session-a',
      messageId: 'compute-message'
    }))
    const hook = renderController(
      options(currentSession, {
        getSession: () => currentSession,
        runtime: { cancelRun: vi.fn(async () => undefined), sendMessage }
      })
    )
    mounted.push(hook)

    let completion!: Promise<{ sessionId: string; messageId: string } | undefined>
    act(() => {
      completion = hook.result.current.lifecycle.enqueueApplication({
        session: currentSession,
        text: 'Analyze job-1.',
        attribution: {
          kind: 'application',
          feature: 'compute',
          purpose: 'job-completion-analysis',
          deliveryKey: 'compute_done:session-a:job-1',
          jobIds: ['job-1']
        }
      })
    })
    expect(hook.result.current.items).toEqual([])
    expect(hook.result.current.hasPendingWork).toBe(true)

    const graph = currentSession.conversationGraph!
    currentSession = {
      ...session('idle'),
      conversationGraph: {
        ...graph,
        frames: graph.frames.map((frame) =>
          frame.id === graph.activeFrameId ? { ...frame, activeBranchId: 'branch-b' } : frame
        ),
        branches: [
          ...graph.branches,
          {
            id: 'branch-b',
            agentFrameId: graph.activeFrameId,
            headMessageId: 'message-b',
            createdAt: 2,
            updatedAt: 2
          }
        ]
      }
    }
    hook.rerender(
      options(currentSession, {
        promptInFlightSessionIds: [],
        getSession: () => currentSession,
        runtime: { cancelRun: vi.fn(async () => undefined), sendMessage }
      })
    )

    await expect(completion).resolves.toBeUndefined()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.hasPendingWork).toBe(false)
  })

  it.each([
    [
      'permission profile',
      (value: ChatSession): ChatSession => ({ ...value, permissionProfile: 'auto' })
    ],
    [
      'Specialist',
      (value: ChatSession): ChatSession => ({ ...value, specialistId: 'specialist-b' })
    ],
    [
      'agent framework',
      (value: ChatSession): ChatSession => ({ ...value, agentFrameworkId: 'claude-code' })
    ],
    [
      'agent backend',
      (value: ChatSession): ChatSession => ({ ...value, agentBackendId: 'backend-b' })
    ],
    [
      'agent configuration',
      (value: ChatSession): ChatSession => ({
        ...value,
        agentConfiguration: {
          providerId: 'openai',
          model: 'gpt-5',
          reasoningEffort: 'high'
        }
      })
    ]
  ])('rejects automatic delivery after its captured %s changes', async (_label, mutate) => {
    let currentSession = session('running')
    const sendMessage = vi.fn(async () => ({
      sessionId: 'session-a',
      messageId: 'compute-message'
    }))
    const hook = renderController(
      options(currentSession, {
        getSession: () => currentSession,
        runtime: { cancelRun: vi.fn(async () => undefined), sendMessage }
      })
    )
    mounted.push(hook)
    const completion = hook.result.current.lifecycle.enqueueApplication({
      session: currentSession,
      text: 'Analyze job-1.',
      attribution: {
        kind: 'application',
        feature: 'compute',
        purpose: 'job-completion-analysis',
        deliveryKey: 'compute_done:session-a:job-1',
        jobIds: ['job-1']
      }
    })

    currentSession = mutate({ ...currentSession, status: 'idle' })
    hook.rerender(
      options(currentSession, {
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession,
        runtime: { cancelRun: vi.fn(async () => undefined), sendMessage }
      })
    )

    await expect(completion).resolves.toBeUndefined()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(hook.result.current.hasPendingWork).toBe(false)
  })

  it('coalesces duplicate in-memory admission for the same Compute delivery key', async () => {
    const idle = session('idle')
    const sendMessage = vi.fn(async () => ({
      sessionId: 'session-a',
      messageId: 'compute-message'
    }))
    const hook = renderController(
      options(idle, {
        getSession: () => idle,
        runtime: { cancelRun: vi.fn(async () => undefined), sendMessage }
      })
    )
    mounted.push(hook)
    const application = {
      session: idle,
      text: 'Analyze job-1.',
      attribution: {
        kind: 'application' as const,
        feature: 'compute' as const,
        purpose: 'job-completion-analysis' as const,
        deliveryKey: 'compute_done:session-a:job-1',
        jobIds: ['job-1']
      }
    }

    const first = hook.result.current.lifecycle.enqueueApplication(application)
    const duplicate = hook.result.current.lifecycle.enqueueApplication(application)

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { sessionId: 'session-a', messageId: 'compute-message' },
      { sessionId: 'session-a', messageId: 'compute-message' }
    ])
    expect(sendMessage).toHaveBeenCalledOnce()
  })
})
