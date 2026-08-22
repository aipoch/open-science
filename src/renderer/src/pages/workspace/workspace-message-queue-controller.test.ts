// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'

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

const admission = (text: string): MessageQueueAdmission => ({
  session: session(),
  snapshot: { draftKey: 'session-a', version: 1, doc: textDoc(text), attachments: [] },
  text,
  forcedSkillIds: [],
  permissionProfile: 'full',
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
  hasPendingPermissionRequest: vi.fn(() => false),
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
    hook.rerender(options(currentSession, { ...input, getSession: () => currentSession }))

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
    hook.rerender(options(currentSession, { ...input, getSession: () => currentSession }))

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

  it('waits for cancellation before Send now dispatches', async () => {
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
    act(() => hook.result.current.lifecycle.enqueue(admission('interrupt')))

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    expect(order).toEqual(['cancel'])
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        promptInFlightSessionIds: [],
        getSession: () => currentSession
      })
    )
    await vi.waitFor(() => expect(order).toEqual(['cancel', 'send']))
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
    expect(input.runtime.cancelRun).toHaveBeenCalledWith('session-a')
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(hook.result.current.items.map((item) => item.text)).toEqual(['second'])

    currentSession = session('running')
    await act(async () => completions[1]())
    expect(hook.result.current.items).toEqual([])
  })

  it('retains the item with a recoverable error when cancellation fails', async () => {
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
      phase: 'error',
      error: { kind: 'cancel', detail: 'runtime refused cancellation' }
    })
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
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

    expect(steerFollowUp).toHaveBeenCalledWith('session-a', 'steer me')
    expect(input.runtime.cancelRun).not.toHaveBeenCalled()
    expect(input.runtime.sendMessage).not.toHaveBeenCalled()
    expect(input.composer.discardSnapshot).toHaveBeenCalledOnce()
    expect(hook.result.current.items).toEqual([])
  })

  it('falls back to interrupt when native follow-up is refused', async () => {
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
    expect(input.runtime.cancelRun).toHaveBeenCalledWith('session-a')
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

  it('does not use native follow-up when the queued item has attachments', async () => {
    let currentSession = session()
    const input = options(currentSession, {
      getSession: () => currentSession,
      runtime: {
        cancelRun: vi.fn(async () => {
          currentSession = session('idle')
        }),
        sendMessage: vi.fn(async () => ({ sessionId: 'session-a', messageId: 'message-sent' })),
        steerFollowUp: vi.fn()
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
          attachments: [
            {
              id: 'upload-1',
              name: 'notes.md',
              mimeType: 'text/markdown',
              size: 12
            } as never
          ]
        }
      })
    )

    await act(async () => hook.result.current.actions.sendNow(hook.result.current.items[0].id))
    expect(input.runtime.steerFollowUp).not.toHaveBeenCalled()
    expect(input.runtime.cancelRun).toHaveBeenCalledWith('session-a')
  })
})
