// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpecialistListItem } from '../../../../shared/specialist'
import type { SessionDeletionResult } from '../../../../shared/session-persistence'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'

import { useWorkspaceSessionController } from './workspace-session-controller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-a',
  projectId: 'project-a',
  title: 'Original title',
  cwd: 'workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const sessionWithRunningChild = (): ChatSession => {
  const rootPrompt = {
    id: 'root-prompt',
    role: 'user' as const,
    content: 'Delegate this work',
    status: 'complete' as const,
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  }
  const graph = createLinearConversationGraph({
    sessionId: 'session-a',
    messages: [rootPrompt],
    createdAt: 1,
    updatedAt: 1
  })
  graph.frames.push({
    id: 'child-frame',
    parentFrameId: graph.rootFrameId,
    originMessageId: rootPrompt.id,
    originBindingState: 'validated',
    kind: 'delegate',
    status: 'running',
    activeBranchId: 'child-branch',
    createdAt: 2
  })
  graph.branches.push({
    id: 'child-branch',
    agentFrameId: 'child-frame',
    createdAt: 2,
    updatedAt: 2
  })
  return session({
    messages: [rootPrompt],
    conversationGraph: graph,
    runtimeContext: {
      version: 1,
      revision: 1,
      delegatedWork: {
        records: [
          {
            agentFrameId: 'child-frame',
            attempts: [
              {
                id: 'child-attempt',
                status: 'running',
                resolvedAgent: { kind: 'main' },
                runtimeSegmentIds: [],
                startedAt: 2
              }
            ]
          }
        ]
      }
    }
  })
}

const specialist = (id: string, name: string): SpecialistListItem =>
  ({ kind: 'custom', id, name, enabled: true }) as SpecialistListItem

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

type Options = Parameters<typeof useWorkspaceSessionController>[0]
type ControllerHook = {
  result: { current: ReturnType<typeof useWorkspaceSessionController> }
  rerender: (next: ChatSession) => void
  unmount: () => void
}

const renderController = (overrides: Partial<Options> = {}): ControllerHook => {
  let activeSession = overrides.activeSession ?? session()
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = {
    current: undefined as unknown as ReturnType<typeof useWorkspaceSessionController>
  }
  const defaults: Options = {
    activeSession,
    selectedSessionId: activeSession.id,
    isPersistenceHydrated: true,
    isPersistenceReady: true,
    canDeleteConversations: true,
    specialistCatalogLoaded: true,
    specialistItems: [],
    loadSpecialists: vi.fn().mockResolvedValue(undefined),
    promptInFlightSessionIds: [],
    sendPreparationInFlightSessionIds: [],
    saveAsSkillInFlightSessionIds: [],
    hasUnfinishedTransfers: vi.fn(() => false),
    beginSessionDeletion: vi.fn(() => true),
    settleSessionDeletion: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue({ status: 'deleted', runtimeDetached: true })
  }
  const Harness = (): null => {
    result.current = useWorkspaceSessionController({
      ...defaults,
      ...overrides,
      activeSession
    })
    return null
  }
  const render = (): void => act(() => root.render(createElement(Harness)))
  render()
  return {
    result,
    rerender: (next: ChatSession): void => {
      activeSession = next
      render()
    },
    unmount: (): void => act(() => root.unmount())
  }
}

const mounted: Array<ReturnType<typeof renderController>> = []
const originalApi = window.api

beforeEach(() => {
  window.api = {} as Window['api']
  useSessionStore.setState(createInitialSessionState())
  useArchiveUndoStore.setState({ notices: [], restoringKey: undefined })
})

afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount()
  window.api = originalApi
})

describe('workspace session controller', () => {
  it('keeps rename whitespace while using trim only as the empty-title gate', () => {
    const active = session()
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const renameSession = vi.spyOn(useSessionStore.getState(), 'renameSession')
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    act(() => {
      hook.result.current.actions.openRename(active)
      hook.result.current.actions.changeRenameDraft('  Retained title  ')
    })
    act(() => hook.result.current.actions.confirmRename({ preventDefault: vi.fn() } as never))

    expect(renameSession).toHaveBeenCalledWith(active.id, '  Retained title  ')
    expect(hook.result.current.view.dialogs.rename).toBeNull()
  })

  it('preserves an own pending Main value when capturing a branch intent', () => {
    const active = session({ status: 'running', specialistId: 'specialist-a' })
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    act(() => hook.result.current.actions.selectSpecialist(undefined))

    expect(hook.result.current.lifecycle.captureSendIntent(true)).toEqual({
      draftSpecialistId: null,
      hasPendingSwitch: false,
      pendingSpecialistId: undefined
    })
    expect(hook.result.current.view.specialist.hasPendingSwitch).toBe(true)
  })

  it('exposes Specialist send admission while the active catalog is unresolved', () => {
    const active = session({ specialistId: 'specialist-a' })
    const hook = renderController({
      activeSession: active,
      specialistCatalogLoaded: false,
      specialistItems: []
    })
    mounted.push(hook)

    expect(hook.result.current.view.specialist.sendAvailable).toBe(false)
    expect(hook.result.current.lifecycle.canStartSend()).toBe(false)
  })

  it('checks Specialist readiness for an inactive Session', () => {
    const active = session()
    const inactive = session({ id: 'session-b', specialistId: 'specialist-b' })
    useSessionStore.setState({ sessions: [active, inactive], selectedSessionId: active.id })
    const hook = renderController({
      activeSession: active,
      specialistItems: [specialist('specialist-b', 'Specialist B')]
    })
    mounted.push(hook)

    expect(hook.result.current.lifecycle.canStartSend(inactive.id)).toBe(true)
  })

  it('archives durably before enqueueing undo and clearing the active selection', async () => {
    const active = session()
    const order: string[] = []
    const updateSessionArchive = vi.fn().mockImplementation(async () => {
      order.push('archive')
      return { ...active, archivedAt: 2 }
    })
    const clearSelection = vi.fn(() => order.push('clear'))
    const enqueueSession = vi.fn(() => order.push('undo'))
    useSessionStore.setState({
      sessions: [active],
      selectedSessionId: active.id,
      updateSessionArchive,
      clearSelection
    })
    useArchiveUndoStore.setState({ enqueueSession })
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.archive(active)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(order).toEqual(['archive', 'undo', 'clear'])
    expect(hook.result.current.lifecycle.canArchive(active)).toBe(true)
  })

  it('does not archive an idle Session while a current child Attempt is running on any branch', () => {
    const active = sessionWithRunningChild()
    const graph = active.conversationGraph
    if (!graph) throw new Error('expected conversation graph')
    const rootFrame = graph.frames.find(({ id }) => id === graph.rootFrameId)
    graph.branches.push({
      id: 'alternate-root-branch',
      agentFrameId: graph.rootFrameId,
      createdAt: 3,
      updatedAt: 3
    })
    if (rootFrame) rootFrame.activeBranchId = 'alternate-root-branch'
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    expect(hook.result.current.lifecycle.canArchive(active)).toBe(false)
  })

  it('does not archive while Save as skill owns prompt admission', () => {
    const active = session()
    const updateSessionArchive = vi.fn()
    useSessionStore.setState({ sessions: [active], updateSessionArchive })
    const hook = renderController({
      activeSession: active,
      saveAsSkillInFlightSessionIds: [active.id]
    })
    mounted.push(hook)

    expect(hook.result.current.lifecycle.canArchive(active)).toBe(false)
    act(() => hook.result.current.actions.archive(active))
    expect(updateSessionArchive).not.toHaveBeenCalled()
  })

  it('fails closed and retains pending identity when the send barrier rejects', async () => {
    const active = session({ status: 'running' })
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const setSessionSpecialist = vi.fn().mockRejectedValue(new Error('switch rejected'))
    window.api = { specialist: { setSessionSpecialist } } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [specialist('specialist-a', 'Specialist A')]
    })
    mounted.push(hook)

    act(() => hook.result.current.actions.selectSpecialist('specialist-a'))
    let ready = true
    await act(async () => {
      ready = await hook.result.current.lifecycle.prepareSpecialistSend(active.id, 'specialist-a')
    })

    expect(ready).toBe(false)
    expect(hook.result.current.lifecycle.captureSendIntent(false).hasPendingSwitch).toBe(true)
    expect(hook.result.current.view.specialist.reconfigureError).toMatchObject({
      specialistName: 'Specialist A',
      message: 'switch rejected'
    })
    expect(hook.result.current.view.specialist.barrierInFlight).toBe(false)
  })

  it('exposes feedback when an idle Session Specialist switch rejects', async () => {
    const active = session({ specialistId: 'specialist-a' })
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const setSessionSpecialist = vi
      .fn()
      .mockRejectedValueOnce(new Error('switch rejected'))
      .mockResolvedValueOnce({ status: 'applied' as const, contextReset: false })
    window.api = { specialist: { setSessionSpecialist } } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [
        specialist('specialist-a', 'Specialist A'),
        specialist('specialist-b', 'Specialist B')
      ]
    })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.selectSpecialist('specialist-b')
      await Promise.resolve()
    })

    expect(hook.result.current.view.specialist.reconfigureError).toMatchObject({
      specialistName: 'Specialist B',
      message: 'switch rejected',
      committed: false
    })
    expect(hook.result.current.view.specialist.barrierInFlight).toBe(false)

    await act(async () => {
      expect(hook.result.current.actions.retrySpecialistSelection()).toBe(true)
      await Promise.resolve()
    })

    expect(setSessionSpecialist).toHaveBeenCalledTimes(2)
    expect(setSessionSpecialist).toHaveBeenLastCalledWith({
      sessionId: active.id,
      specialistId: 'specialist-b'
    })
    expect(useSessionStore.getState().sessions[0].specialistId).toBe('specialist-b')
    expect(hook.result.current.view.specialist.reconfigureError).toBeNull()
  })

  it('keeps idle Specialist failures scoped to each Session', async () => {
    const first = session({ specialistId: 'specialist-a' })
    const second = session({ id: 'session-b', specialistId: 'specialist-a' })
    useSessionStore.setState({ sessions: [first, second], selectedSessionId: first.id })
    const setSessionSpecialist = vi
      .fn()
      .mockRejectedValueOnce(new Error('switch rejected'))
      .mockRejectedValueOnce(new Error('other switch rejected'))
      .mockResolvedValue({ status: 'applied' as const, contextReset: false })
    window.api = { specialist: { setSessionSpecialist } } as unknown as Window['api']
    const hook = renderController({
      activeSession: first,
      specialistItems: [
        specialist('specialist-a', 'Specialist A'),
        specialist('specialist-b', 'Specialist B')
      ]
    })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.selectSpecialist('specialist-b')
      await Promise.resolve()
    })
    hook.rerender(second)
    await act(async () => {
      hook.result.current.actions.selectSpecialist('specialist-b')
      await Promise.resolve()
    })
    hook.rerender(first)

    expect(hook.result.current.view.specialist.reconfigureError).toMatchObject({
      sessionId: first.id,
      message: 'switch rejected'
    })
    await act(async () => {
      expect(hook.result.current.actions.retrySpecialistSelection()).toBe(true)
      await Promise.resolve()
    })
    expect(setSessionSpecialist).toHaveBeenLastCalledWith({
      sessionId: first.id,
      specialistId: 'specialist-b'
    })

    hook.rerender(second)
    expect(hook.result.current.view.specialist.reconfigureError).toMatchObject({
      sessionId: second.id,
      message: 'other switch rejected'
    })
    await act(async () => {
      expect(hook.result.current.actions.retrySpecialistSelection()).toBe(true)
      await Promise.resolve()
    })
    expect(setSessionSpecialist).toHaveBeenLastCalledWith({
      sessionId: second.id,
      specialistId: 'specialist-b'
    })
  })

  it('keeps recovery available when switching back to Main Agent rejects', async () => {
    const active = session({ specialistId: 'specialist-a' })
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const setSessionSpecialist = vi
      .fn()
      .mockRejectedValueOnce(new Error('specialist switch rejected'))
      .mockRejectedValueOnce(new Error('main switch rejected'))
      .mockResolvedValueOnce({ status: 'applied' as const, contextReset: false })
    window.api = { specialist: { setSessionSpecialist } } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [
        specialist('specialist-a', 'Specialist A'),
        specialist('specialist-b', 'Specialist B')
      ]
    })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.selectSpecialist('specialist-b')
      await Promise.resolve()
    })
    await act(async () => {
      hook.result.current.actions.useMainAgent()
      await Promise.resolve()
    })

    expect(setSessionSpecialist).toHaveBeenLastCalledWith({
      sessionId: active.id,
      specialistId: undefined
    })
    expect(hook.result.current.view.specialist.reconfigureError).toMatchObject({
      specialistName: 'Main Agent',
      message: 'main switch rejected',
      committed: false
    })
    await act(async () => {
      expect(hook.result.current.actions.retrySpecialistSelection()).toBe(true)
      await Promise.resolve()
    })
    expect(setSessionSpecialist).toHaveBeenCalledTimes(3)
    expect(hook.result.current.view.specialist.reconfigureError).toBeNull()
  })

  it('coordinates duplicate deletion through the composer transaction boundary', async () => {
    const active = session()
    const deletion = deferred<SessionDeletionResult>()
    const beginSessionDeletion = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const settleSessionDeletion = vi.fn()
    const deleteSession = vi.fn(() => deletion.promise)
    const hook = renderController({
      activeSession: active,
      beginSessionDeletion,
      settleSessionDeletion,
      deleteSession
    })
    mounted.push(hook)

    act(() => hook.result.current.actions.openDelete(active))
    act(() => hook.result.current.actions.confirmDelete())
    act(() => hook.result.current.actions.confirmDelete())
    expect(deleteSession).toHaveBeenCalledOnce()
    expect(deleteSession).toHaveBeenCalledWith({
      projectId: active.projectId,
      sessionId: active.id
    })
    expect(hook.result.current.view.dialogs.delete?.session.id).toBe(active.id)
    expect(hook.result.current.view.dialogs.delete?.isDeleting).toBe(true)

    await act(async () => {
      deletion.resolve({ status: 'deleted', runtimeDetached: true })
      await deletion.promise
    })
    expect(settleSessionDeletion).toHaveBeenCalledWith(active.id, true)
    expect(hook.result.current.view.deletingIds.has(active.id)).toBe(false)
    expect(hook.result.current.view.dialogs.delete).toBeNull()
  })

  it('keeps a background Session dialog open with a retryable persistence error', async () => {
    const active = session({ id: 'session-active' })
    const background = session({ id: 'session-background' })
    const deleteSession = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed',
        reason: 'persistence',
        runtimeDetached: true
      })
      .mockResolvedValueOnce({ status: 'deleted', runtimeDetached: true })
    const settleSessionDeletion = vi.fn()
    const hook = renderController({
      activeSession: active,
      deleteSession,
      settleSessionDeletion
    })
    mounted.push(hook)

    act(() => hook.result.current.actions.openDelete(background))
    await act(async () => hook.result.current.actions.confirmDelete())

    expect(hook.result.current.view.dialogs.delete).toMatchObject({
      session: { id: background.id },
      isDeleting: false,
      error: 'persistence'
    })
    expect(settleSessionDeletion).toHaveBeenLastCalledWith(background.id, false)

    await act(async () => hook.result.current.actions.confirmDelete())

    expect(deleteSession).toHaveBeenNthCalledWith(2, {
      projectId: background.projectId,
      sessionId: background.id
    })
    expect(settleSessionDeletion).toHaveBeenLastCalledWith(background.id, true)
    expect(hook.result.current.view.dialogs.delete).toBeNull()
  })
})
