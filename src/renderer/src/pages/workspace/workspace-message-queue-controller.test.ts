// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'

import { type ComposerDoc } from './composer/composer-doc'
import {
  useWorkspaceMessageQueueController,
  type MessageQueueAdmission,
  type WorkspaceMessageQueueController,
  type WorkspaceMessageQueueControllerOptions
} from './workspace-message-queue-controller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

const session = (status: ChatSession['status'] = 'running'): ChatSession => ({
  id: 'session-a',
  projectId: 'project-a',
  title: 'Session A',
  cwd: '/workspace/project-a',
  status,
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
  sideChatOpen: false,
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
  abortFixLoop: vi.fn(async () => undefined),
  getSession: () => activeSession,
  subscribeSessionChanges: () => () => undefined,
  ...overrides
})

type Hook = {
  result: { current: WorkspaceMessageQueueController }
  rerender: (next: WorkspaceMessageQueueControllerOptions) => void
  unmount: () => void
}

const renderController = (initial: WorkspaceMessageQueueControllerOptions): Hook => {
  let current = initial
  const root: Root = createRoot(document.createElement('div'))
  const result = { current: undefined as unknown as WorkspaceMessageQueueController }
  const Harness = (): null => {
    result.current = useWorkspaceMessageQueueController(current)
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

describe('workspace message queue controller', () => {
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

  it('does not strand an in-flight item when Send now promotes another item', async () => {
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
      runtime: { cancelRun: vi.fn(async () => undefined), sendMessage }
    })
    const hook = renderController(input)
    mounted.push(hook)

    act(() => hook.result.current.lifecycle.enqueue({ ...admission('first'), session: currentSession }))
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    act(() => hook.result.current.lifecycle.enqueue({ ...admission('second'), session: currentSession }))

    const secondId = hook.result.current.items[1].id
    await act(async () => hook.result.current.actions.sendNow(secondId))
    expect(sendMessage).toHaveBeenCalledTimes(2)

    currentSession = session('running')
    hook.rerender(
      options(currentSession, {
        ...input,
        activeSession: currentSession,
        getSession: () => currentSession
      })
    )
    await act(async () => completions[0]())
    expect(hook.result.current.items.map((item) => item.text)).toEqual(['second'])

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
})
