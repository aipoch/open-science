// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpecialistListItem } from '../../../../shared/specialist'
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
    hasUnfinishedTransfers: vi.fn(() => false),
    beginSessionDeletion: vi.fn(() => true),
    settleSessionDeletion: vi.fn(),
    deleteRuntimeSession: vi.fn().mockResolvedValue(true)
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

  it('coordinates duplicate deletion through the composer transaction boundary', async () => {
    const active = session()
    const deletion = deferred<boolean>()
    const beginSessionDeletion = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const settleSessionDeletion = vi.fn()
    const deleteRuntimeSession = vi.fn(() => deletion.promise)
    const hook = renderController({
      activeSession: active,
      beginSessionDeletion,
      settleSessionDeletion,
      deleteRuntimeSession
    })
    mounted.push(hook)

    act(() => hook.result.current.actions.openDelete(active))
    act(() => hook.result.current.actions.confirmDelete())
    act(() => hook.result.current.actions.openDelete(active))
    act(() => hook.result.current.actions.confirmDelete())
    expect(deleteRuntimeSession).toHaveBeenCalledOnce()

    await act(async () => {
      deletion.resolve(true)
      await deletion.promise
    })
    expect(settleSessionDeletion).toHaveBeenCalledWith(active.id, true)
    expect(hook.result.current.view.deletingIds.has(active.id)).toBe(false)
  })
})
