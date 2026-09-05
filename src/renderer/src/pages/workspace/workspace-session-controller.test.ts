// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CompletionHandoffLifecycleEvent,
  SpecialistListItem
} from '../../../../shared/specialist'
import type {
  PersistedChatSession,
  SessionDeletionResult
} from '../../../../shared/session-persistence'
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

const sessionWithPendingDelegatedQuestion = (): ChatSession => {
  const pending = sessionWithRunningChild()
  const graph = pending.conversationGraph
  const delegatedWork = pending.runtimeContext?.delegatedWork
  const child = graph?.frames.find(({ id }) => id === 'child-frame')
  const root = graph?.frames.find(({ id }) => id === graph.rootFrameId)
  const attempt = delegatedWork?.records[0]?.attempts[0]
  if (!graph || !delegatedWork || !child || !root || !attempt) {
    throw new Error('Invalid delegated Session fixture')
  }

  Object.assign(child, { status: 'completed', delegateName: 'Researcher' })
  Object.assign(attempt, { status: 'completed', endedAt: 3 })
  Object.assign(delegatedWork, {
    questionRequests: [
      {
        requestId: 'question-1',
        canonicalDigest: 'a'.repeat(64),
        sourceFrameId: child.id,
        sourceAttemptId: attempt.id,
        sourceRuntimeSegmentId: 'runtime-1',
        sourceMessageBranchId: child.activeBranchId,
        rootOriginMessageId: 'root-prompt',
        rootBranchId: root.activeBranchId,
        sourceName: 'Researcher',
        questions: [{ question: 'Choose a source' }],
        askedAt: 3,
        status: 'pending',
        draftAnswers: [],
        draftQuestionIndex: 0
      }
    ]
  })
  return pending
}

const specialist = (id: string, name: string): SpecialistListItem =>
  ({ kind: 'custom', id, name, enabled: true }) as SpecialistListItem

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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
  it('loads an unopened Session before opening Edit session', async () => {
    const summary = session({ contentLoaded: false, activeMessageCount: 1 })
    const persisted: PersistedChatSession = {
      id: summary.id,
      projectId: summary.projectId,
      revision: 3,
      title: summary.title,
      description: 'Durable description',
      cwd: summary.cwd,
      status: summary.status,
      messages: [],
      createdAt: summary.createdAt,
      updatedAt: 2
    }
    const loadOne = vi.fn().mockResolvedValue(persisted)
    window.api = { sessions: { loadOne } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [summary], selectedSessionId: summary.id })
    const hook = renderController({ activeSession: summary })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.openEdit(summary)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project-a', sessionId: 'session-a' })
    expect(hook.result.current.view.dialogs.edit).toMatchObject({
      titleDraft: 'Original title',
      descriptionDraft: 'Durable description',
      isSaving: false
    })
  })

  it('keeps the latest Edit-session intent when an older lazy load finishes last', async () => {
    const first = session({ id: 'session-a', contentLoaded: false })
    const second = session({ id: 'session-b', title: 'Second title', contentLoaded: false })
    const firstLoad = deferred<PersistedChatSession | undefined>()
    const secondLoad = deferred<PersistedChatSession | undefined>()
    const loadOne = vi.fn(({ sessionId }: { sessionId: string }) =>
      sessionId === first.id ? firstLoad.promise : secondLoad.promise
    )
    window.api = { sessions: { loadOne } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [first, second], selectedSessionId: first.id })
    const hook = renderController({ activeSession: first })
    mounted.push(hook)

    act(() => {
      hook.result.current.actions.openEdit(first)
      hook.result.current.actions.openEdit(second)
    })
    await act(async () => {
      secondLoad.resolve({ ...second, revision: 1, messages: [] })
      await secondLoad.promise
    })
    await act(async () => {
      firstLoad.resolve({ ...first, revision: 1, messages: [] })
      await firstLoad.promise
    })

    expect(hook.result.current.view.dialogs.edit?.session.id).toBe(second.id)
  })

  it('submits title and description through the dedicated edit command and applies its authority', async () => {
    const active = session({ revision: 2, description: 'Before' })
    const edited: PersistedChatSession = {
      ...active,
      title: 'After',
      description: '',
      sessionDetailsSource: 'manual',
      revision: 3,
      updatedAt: 3
    }
    const editDetails = vi.fn().mockResolvedValue(edited)
    window.api = { sessions: { editDetails } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    act(() => {
      hook.result.current.actions.openEdit(active)
      hook.result.current.actions.changeEditTitleDraft('  After  ')
      hook.result.current.actions.changeEditDescriptionDraft('')
    })
    act(() => hook.result.current.actions.confirmEdit({ preventDefault: vi.fn() } as never))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(editDetails).toHaveBeenCalledWith({
      projectId: active.projectId,
      sessionId: active.id,
      expectedTitle: 'Original title',
      expectedDescription: 'Before',
      title: '  After  ',
      description: ''
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'After',
      description: '',
      sessionDetailsSource: 'manual',
      revision: 3
    })
    expect(hook.result.current.view.dialogs.edit).toBeNull()
  })

  it('does not close a newly opened Edit dialog when the previous save succeeds', async () => {
    const first = session({ id: 'session-a', title: 'First' })
    const second = session({ id: 'session-b', title: 'Second' })
    const firstSave = deferred<PersistedChatSession>()
    window.api = {
      sessions: { editDetails: vi.fn().mockReturnValue(firstSave.promise) }
    } as unknown as Window['api']
    useSessionStore.setState({ sessions: [first, second], selectedSessionId: first.id })
    const hook = renderController({ activeSession: first })
    mounted.push(hook)

    act(() => hook.result.current.actions.openEdit(first))
    act(() => hook.result.current.actions.confirmEdit({ preventDefault: vi.fn() } as never))
    act(() => hook.result.current.actions.openEdit(second))

    await act(async () => {
      firstSave.resolve({ ...first, revision: 2 })
      await firstSave.promise
    })

    expect(hook.result.current.view.dialogs.edit).toMatchObject({
      session: { id: second.id },
      titleDraft: second.title,
      isSaving: false
    })
  })

  it.each([
    [
      Object.assign(new Error('Session details changed elsewhere.'), {
        code: 'session-details-conflict'
      }),
      "This session's title or description changed in another window. Your changes were not saved. Close and reopen the editor to review the latest details."
    ],
    [new Error('disk failure'), 'Could not save session details.']
  ])('keeps Edit session open with a visible save error', async (failure, expectedMessage) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const active = session({ description: 'Original description' })
    const editDetails = vi.fn().mockRejectedValue(failure)
    window.api = { sessions: { editDetails } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    try {
      act(() => hook.result.current.actions.openEdit(active))
      act(() => hook.result.current.actions.changeEditTitleDraft('Unsaved title'))
      act(() => hook.result.current.actions.confirmEdit({ preventDefault: vi.fn() } as never))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(hook.result.current.view.dialogs.edit).toMatchObject({
        titleDraft: 'Unsaved title',
        descriptionDraft: 'Original description',
        isSaving: false,
        error: expectedMessage
      })
    } finally {
      warn.mockRestore()
    }
  })

  it('does not clear a new Edit save state when the previous save fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const first = session({ id: 'session-a', title: 'First' })
    const second = session({ id: 'session-b', title: 'Second' })
    const firstSave = deferred<PersistedChatSession>()
    const secondSave = deferred<PersistedChatSession>()
    window.api = {
      sessions: {
        editDetails: vi
          .fn()
          .mockReturnValueOnce(firstSave.promise)
          .mockReturnValueOnce(secondSave.promise)
      }
    } as unknown as Window['api']
    useSessionStore.setState({ sessions: [first, second], selectedSessionId: first.id })
    const hook = renderController({ activeSession: first })
    mounted.push(hook)

    act(() => hook.result.current.actions.openEdit(first))
    act(() => hook.result.current.actions.confirmEdit({ preventDefault: vi.fn() } as never))
    act(() => hook.result.current.actions.openEdit(second))
    act(() => hook.result.current.actions.confirmEdit({ preventDefault: vi.fn() } as never))

    try {
      await act(async () => {
        firstSave.reject(new Error('first save failed'))
        await firstSave.promise.catch(() => undefined)
      })

      expect(hook.result.current.view.dialogs.edit).toMatchObject({
        session: { id: second.id },
        isSaving: true
      })
    } finally {
      await act(async () => {
        secondSave.resolve({ ...second, revision: 2 })
        await secondSave.promise
        await Promise.resolve()
      })
      warn.mockRestore()
    }
  })

  it('renames a Session title inline through the session-details mutation', async () => {
    const active = session({ description: 'Keep me' })
    const edited: PersistedChatSession = {
      ...active,
      title: 'Renamed inline',
      description: 'Keep me',
      sessionDetailsSource: 'manual',
      revision: 2,
      updatedAt: 2
    }
    const editDetails = vi.fn().mockResolvedValue(edited)
    window.api = { sessions: { editDetails } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    await act(async () => {
      await hook.result.current.actions.renameTitle(active, '  Renamed inline  ')
    })

    expect(editDetails).toHaveBeenCalledWith({
      projectId: active.projectId,
      sessionId: active.id,
      expectedTitle: 'Original title',
      expectedDescription: 'Keep me',
      title: 'Renamed inline',
      description: 'Keep me'
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Renamed inline',
      sessionDetailsSource: 'manual',
      revision: 2
    })
  })

  it('ignores blank or unchanged inline rename titles', () => {
    const active = session()
    const editDetails = vi.fn()
    window.api = { sessions: { editDetails } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    act(() => {
      void hook.result.current.actions.renameTitle(active, '   ')
      void hook.result.current.actions.renameTitle(active, 'Original title')
    })

    expect(editDetails).not.toHaveBeenCalled()
  })

  it('loads an unopened Session before an inline rename to preserve its description', async () => {
    const summary = session({ contentLoaded: false, activeMessageCount: 1 })
    const latestSummary = { ...summary, title: 'Title updated in another window' }
    const persisted: PersistedChatSession = {
      id: summary.id,
      projectId: summary.projectId,
      title: 'Title updated in another window',
      description: 'Durable description',
      cwd: summary.cwd,
      status: summary.status,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Rename me',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt
    }
    const loadOne = vi.fn().mockResolvedValue(persisted)
    const editDetails = vi
      .fn()
      .mockResolvedValue({ ...persisted, title: 'Renamed', sessionDetailsSource: 'manual' })
    window.api = { sessions: { loadOne, editDetails } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [latestSummary], selectedSessionId: summary.id })
    const hook = renderController({ activeSession: latestSummary })
    mounted.push(hook)

    await act(async () => {
      await hook.result.current.actions.renameTitle(latestSummary, 'Renamed', summary.title)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project-a', sessionId: 'session-a' })
    expect(editDetails).toHaveBeenCalledWith({
      projectId: 'project-a',
      sessionId: 'session-a',
      expectedTitle: 'Original title',
      expectedDescription: 'Durable description',
      title: 'Renamed',
      description: 'Durable description'
    })
  })

  it('reports an unopened Session load failure without turning it into a save failure', async () => {
    const summary = session({ contentLoaded: false, activeMessageCount: 1 })
    const loadOne = vi.fn().mockRejectedValue(new Error('read failure'))
    const editDetails = vi.fn()
    window.api = { sessions: { loadOne, editDetails } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [summary], selectedSessionId: summary.id })
    const hook = renderController({ activeSession: summary })
    mounted.push(hook)

    await act(async () => {
      await expect(hook.result.current.actions.renameTitle(summary, 'Renamed')).resolves.toBe(false)
    })

    expect(hook.result.current.view.exportError).toBe('Could not load this session for editing.')
    expect(editDetails).not.toHaveBeenCalled()
  })

  it('loads an unopened Session before opening conversation export', async () => {
    const summary = session({ contentLoaded: false, activeMessageCount: 1 })
    const persisted: PersistedChatSession = {
      id: summary.id,
      projectId: summary.projectId,
      title: summary.title,
      cwd: summary.cwd,
      status: summary.status,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Export me',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt
    }
    const loadOne = vi.fn().mockResolvedValue(persisted)
    window.api = { sessions: { loadOne } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [summary], selectedSessionId: summary.id })
    const hook = renderController({ activeSession: summary })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.openExportConversation(summary)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loadOne).toHaveBeenCalledWith({
      projectId: summary.projectId,
      sessionId: summary.id
    })
    expect(hook.result.current.view.dialogs.exportConversation?.messages).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0]?.contentLoaded).not.toBe(false)
  })

  it('does not resurrect a deleted Session when export hydration finishes', async () => {
    const summary = session({ contentLoaded: false, activeMessageCount: 1 })
    const persisted: PersistedChatSession = {
      id: summary.id,
      projectId: summary.projectId,
      title: summary.title,
      cwd: summary.cwd,
      status: summary.status,
      messages: [],
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt
    }
    const load = deferred<PersistedChatSession | undefined>()
    const loadOne = vi.fn(() => load.promise)
    window.api = { sessions: { loadOne } } as unknown as Window['api']
    useSessionStore.setState({ sessions: [summary], selectedSessionId: summary.id })
    const hook = renderController({ activeSession: summary })
    mounted.push(hook)

    act(() => hook.result.current.actions.openExportConversation(summary))
    expect(loadOne).toHaveBeenCalledOnce()

    await act(async () => {
      useSessionStore.getState().deleteSession(summary.id)
      load.resolve(persisted)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(hook.result.current.view.dialogs.exportConversation).toBeNull()
  })

  it('does not open conversation export after its lazy-load intent is closed', async () => {
    const summary = session({ contentLoaded: false, activeMessageCount: 1 })
    const load = deferred<PersistedChatSession | undefined>()
    window.api = {
      sessions: { loadOne: vi.fn().mockReturnValue(load.promise) }
    } as unknown as Window['api']
    useSessionStore.setState({ sessions: [summary], selectedSessionId: summary.id })
    const hook = renderController({ activeSession: summary })
    mounted.push(hook)

    act(() => {
      hook.result.current.actions.openExportConversation(summary)
      hook.result.current.actions.closeExportConversation()
    })
    await act(async () => {
      load.resolve({ ...summary, revision: 1, messages: [] })
      await load.promise
    })

    expect(hook.result.current.view.dialogs.exportConversation).toBeNull()
  })

  it('localizes an unopened Session export load failure', async () => {
    const summary = session({ contentLoaded: false })
    window.api = {
      sessions: { loadOne: vi.fn().mockRejectedValue(new Error('private path leaked')) }
    } as unknown as Window['api']
    const hook = renderController({ activeSession: summary })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.openExportConversation(summary)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(hook.result.current.view.exportError).toBe('Could not load this session for export.')
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

  it('blocks sends until active and background Session content is loaded', () => {
    const active = session({ contentLoaded: false })
    const inactive = session({ id: 'session-b', contentLoaded: false })
    useSessionStore.setState({ sessions: [active, inactive], selectedSessionId: active.id })
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    expect(hook.result.current.lifecycle.canStartSend()).toBe(false)
    expect(hook.result.current.lifecycle.canStartSend(inactive.id)).toBe(false)
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

  it('does not archive while context compaction owns the Session', () => {
    const active = session()
    const updateSessionArchive = vi.fn()
    useSessionStore.setState({
      sessions: [active],
      selectedSessionId: active.id,
      updateSessionArchive
    })
    useSessionStore.getState().beginCompaction(active.id)
    const compacting = useSessionStore.getState().sessions[0]
    const hook = renderController({ activeSession: compacting })
    mounted.push(hook)

    expect(hook.result.current.lifecycle.canArchive(compacting)).toBe(false)
    act(() => hook.result.current.actions.archive(compacting))
    expect(updateSessionArchive).not.toHaveBeenCalled()
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

  it('does not archive an idle Session while a delegated question awaits an answer', () => {
    const active = sessionWithPendingDelegatedQuestion()
    const updateSessionArchive = vi.fn()
    useSessionStore.setState({ sessions: [active], updateSessionArchive })
    const hook = renderController({ activeSession: active })
    mounted.push(hook)

    expect(hook.result.current.lifecycle.canArchive(active)).toBe(false)
    act(() => hook.result.current.actions.archive(active))
    expect(updateSessionArchive).not.toHaveBeenCalled()
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
    expect(hook.result.current.view.specialist.historyId).toBe('specialist-a')
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

  it('exposes an idle Session Specialist selection while reconfiguration is in flight', async () => {
    const active = session({ specialistId: 'specialist-a' })
    const switchRequest = deferred<{ status: 'applied'; contextReset: boolean }>()
    const setSessionSpecialist = vi.fn(() => switchRequest.promise)
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    window.api = { specialist: { setSessionSpecialist } } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [
        specialist('specialist-a', 'Specialist A'),
        specialist('specialist-b', 'Specialist B')
      ]
    })
    mounted.push(hook)

    act(() => hook.result.current.actions.selectSpecialist('specialist-b'))

    expect(setSessionSpecialist).toHaveBeenCalledWith({
      sessionId: active.id,
      specialistId: 'specialist-b'
    })
    expect(hook.result.current.view.specialist.barrierInFlight).toBe(true)
    const visibleSpecialistWhilePending = hook.result.current.view.specialist.historyId

    await act(async () => {
      switchRequest.resolve({ status: 'applied', contextReset: false })
      await switchRequest.promise
    })

    expect(visibleSpecialistWhilePending).toBe('specialist-b')
    expect(useSessionStore.getState().sessions[0].specialistId).toBe('specialist-b')
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

  it('discards an idle Specialist failure after its Session is deleted', async () => {
    const active = session({ specialistId: 'specialist-a' })
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const setSessionSpecialist = vi.fn().mockRejectedValue(new Error('switch rejected'))
    window.api = { specialist: { setSessionSpecialist } } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [specialist('specialist-b', 'Specialist B')]
    })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.selectSpecialist('specialist-b')
      await Promise.resolve()
    })
    act(() => hook.result.current.actions.openDelete(active))
    await act(async () => {
      hook.result.current.actions.confirmDelete()
      await Promise.resolve()
    })
    hook.rerender(session({ id: active.id }))

    expect(hook.result.current.view.specialist.reconfigureError).toBeNull()
  })

  it('discards an idle Specialist failure after its Session is archived', async () => {
    const active = session({ specialistId: 'specialist-a' })
    const updateSessionArchive = vi.fn().mockResolvedValue({ ...active, archivedAt: 2 })
    useSessionStore.setState({
      sessions: [active],
      selectedSessionId: active.id,
      updateSessionArchive
    })
    const setSessionSpecialist = vi.fn().mockRejectedValue(new Error('switch rejected'))
    window.api = { specialist: { setSessionSpecialist } } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [specialist('specialist-b', 'Specialist B')]
    })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.selectSpecialist('specialist-b')
      await Promise.resolve()
    })
    await act(async () => {
      hook.result.current.actions.archive(active)
      await Promise.resolve()
    })
    hook.rerender(session({ id: active.id }))

    expect(hook.result.current.view.specialist.reconfigureError).toBeNull()
  })

  it('ignores an idle Specialist rejection that arrives after archival', async () => {
    const active = session({ specialistId: 'specialist-a' })
    const updateSessionArchive = vi.fn().mockResolvedValue({ ...active, archivedAt: 2 })
    let rejectSwitch!: (error: Error) => void
    const switchPromise = new Promise<never>((_resolve, reject) => {
      rejectSwitch = reject
    })
    useSessionStore.setState({
      sessions: [active],
      selectedSessionId: active.id,
      updateSessionArchive
    })
    const setSessionSpecialist = vi.fn(() => switchPromise)
    window.api = { specialist: { setSessionSpecialist } } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [specialist('specialist-b', 'Specialist B')]
    })
    mounted.push(hook)

    act(() => hook.result.current.actions.selectSpecialist('specialist-b'))
    await act(async () => {
      hook.result.current.actions.archive(active)
      await Promise.resolve()
    })
    await act(async () => {
      rejectSwitch(new Error('late switch rejection'))
      await switchPromise.catch(() => undefined)
    })
    hook.rerender(session({ id: active.id }))

    expect(hook.result.current.view.specialist.reconfigureError).toBeNull()
    expect(hook.result.current.actions.retrySpecialistSelection()).toBe(false)
  })

  it('discards an idle Specialist failure after an authoritative handoff', async () => {
    const active = session({ specialistId: 'specialist-a' })
    const authoritative = specialist('specialist-c', 'Specialist C')
    let handoffListener: ((event: CompletionHandoffLifecycleEvent) => void) | undefined
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const setSessionSpecialist = vi.fn().mockRejectedValue(new Error('switch rejected'))
    window.api = {
      specialist: {
        setSessionSpecialist,
        resolveSessionSpecialist: vi.fn().mockResolvedValue({
          kind: 'bound',
          profile: authoritative
        }),
        onHandoffLifecycleEvent: vi.fn((listener) => {
          handoffListener = listener
          return () => undefined
        })
      }
    } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [specialist('specialist-b', 'Specialist B'), authoritative]
    })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.selectSpecialist('specialist-b')
      await Promise.resolve()
    })
    await act(async () => {
      handoffListener?.({
        id: 'handoff-1',
        sessionId: active.id,
        sequence: 1,
        observedAt: 1,
        phase: 'continuation-start',
        target: 'Specialist C',
        provenance: { originatingTurnId: 'turn-1', attachmentIds: [], artifactIds: [] }
      })
      await Promise.resolve()
    })

    expect(useSessionStore.getState().sessions[0].specialistId).toBe('specialist-c')
    expect(hook.result.current.view.specialist.reconfigureError).toBeNull()
    expect(hook.result.current.actions.retrySpecialistSelection()).toBe(false)
    expect(setSessionSpecialist).toHaveBeenCalledOnce()
  })

  it('clears an in-flight idle selection after an authoritative handoff supersedes it', async () => {
    const active = session({ specialistId: 'specialist-a' })
    const authoritative = specialist('specialist-c', 'Specialist C')
    const switchRequest = deferred<{ status: 'applied'; contextReset: boolean }>()
    let handoffListener: ((event: CompletionHandoffLifecycleEvent) => void) | undefined
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    window.api = {
      specialist: {
        setSessionSpecialist: vi.fn(() => switchRequest.promise),
        resolveSessionSpecialist: vi.fn().mockResolvedValue({
          kind: 'bound',
          profile: authoritative
        }),
        onHandoffLifecycleEvent: vi.fn((listener) => {
          handoffListener = listener
          return () => undefined
        })
      }
    } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [specialist('specialist-b', 'Specialist B'), authoritative]
    })
    mounted.push(hook)

    act(() => hook.result.current.actions.selectSpecialist('specialist-b'))
    await act(async () => {
      handoffListener?.({
        id: 'handoff-1',
        sessionId: active.id,
        sequence: 1,
        observedAt: 1,
        phase: 'continuation-start',
        target: 'Specialist C',
        provenance: { originatingTurnId: 'turn-1', attachmentIds: [], artifactIds: [] }
      })
      await Promise.resolve()
    })
    hook.rerender(useSessionStore.getState().sessions[0])

    expect(hook.result.current.view.specialist.historyId).toBe('specialist-c')
    expect(hook.result.current.lifecycle.captureSendIntent(false)).toMatchObject({
      hasPendingSwitch: false,
      pendingSpecialistId: 'specialist-c'
    })

    await act(async () => {
      switchRequest.resolve({ status: 'applied', contextReset: false })
      await switchRequest.promise
    })
    hook.rerender(useSessionStore.getState().sessions[0])

    expect(useSessionStore.getState().sessions[0].specialistId).toBe('specialist-c')
    expect(hook.result.current.view.specialist.historyId).toBe('specialist-c')
  })

  it('discards an idle Specialist failure after a newer pending-switch update', async () => {
    const active = session({ specialistId: 'specialist-a' })
    let pendingSwitchListener:
      ((pending: { sessionId: string; targetName: string | null }) => void) | undefined
    useSessionStore.setState({ sessions: [active], selectedSessionId: active.id })
    const setSessionSpecialist = vi.fn().mockRejectedValue(new Error('switch rejected'))
    window.api = {
      specialist: {
        setSessionSpecialist,
        onPendingSwitch: vi.fn((listener) => {
          pendingSwitchListener = listener
          return () => undefined
        })
      }
    } as unknown as Window['api']
    const hook = renderController({
      activeSession: active,
      specialistItems: [
        specialist('specialist-b', 'Specialist B'),
        specialist('specialist-c', 'Specialist C')
      ]
    })
    mounted.push(hook)

    await act(async () => {
      hook.result.current.actions.selectSpecialist('specialist-b')
      await Promise.resolve()
    })
    act(() => pendingSwitchListener?.({ sessionId: active.id, targetName: 'Specialist C' }))

    expect(hook.result.current.lifecycle.captureSendIntent(false)).toMatchObject({
      hasPendingSwitch: true,
      pendingSpecialistId: 'specialist-c'
    })
    expect(hook.result.current.view.specialist.reconfigureError).toBeNull()
    expect(hook.result.current.actions.retrySpecialistSelection()).toBe(false)
    expect(setSessionSpecialist).toHaveBeenCalledOnce()
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

  it('settles committed deletion and reports unfinished cleanup without offering a live Session retry', async () => {
    const active = session()
    const settleSessionDeletion = vi.fn()
    const hook = renderController({
      activeSession: active,
      settleSessionDeletion,
      deleteSession: vi.fn().mockResolvedValue({
        status: 'deleted',
        runtimeDetached: true,
        cleanupPending: true
      })
    })
    mounted.push(hook)
    act(() => hook.result.current.actions.openDelete(active))
    await act(async () => hook.result.current.actions.confirmDelete())

    expect(settleSessionDeletion).toHaveBeenCalledWith(active.id, true)
    expect(hook.result.current.view.dialogs.delete).toBeNull()
    expect(hook.result.current.view.exportError).toBe(
      'The Session was deleted, but some cleanup could not be completed.'
    )
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
