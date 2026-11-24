import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_HISTORY_CURSOR_STALE,
  type SessionHistoryPage
} from '../../../../shared/session-history'
import type {
  PersistedChatSession,
  PersistedChatMessage,
  PersistedToolActivity
} from '../../../../shared/session-persistence'
import { materializeSessionConversationGraph } from '../../../../shared/session-persistence'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  projectConversationMessage,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages
} from '../../../../shared/conversation-graph'
import {
  createInitialSessionState,
  hydrateSession,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import { applySessionMetadataReceipt, createStoreSaver } from './session-persistence'
import { ensureSessionContentLoaded, loadSessionHistoryPage } from './session-history'

const request = { projectId: 'project', sessionId: 'history' }
const message = (id: string, createdAt: number): PersistedChatMessage => ({
  id,
  createdAt,
  updatedAt: createdAt,
  content: id,
  role: 'user' as const,
  status: 'complete' as const,
  eventIds: []
})
const session = (messages = [message('newest', 3)]): PersistedChatSession => ({
  id: request.sessionId,
  projectId: request.projectId,
  title: 'History',
  cwd: '/workspace',
  status: 'idle',
  messages,
  revision: 4,
  createdAt: 1,
  updatedAt: 4
})
const page = (overrides: Partial<SessionHistoryPage> = {}): SessionHistoryPage => ({
  ...request,
  revision: 4,
  session: session(),
  totalItems: 200,
  hasMore: true,
  beforeCursor: 'older',
  ...overrides
})
const current = (): ReturnType<typeof useSessionStore.getState>['sessions'][number] =>
  useSessionStore.getState().sessions[0]!

beforeEach(() =>
  useSessionStore.setState({
    ...createInitialSessionState(),
    sessions: [{ ...hydrateSession(session([])), contentLoaded: false }]
  })
)

describe('display-only session history pages', () => {
  it.each(['runtime', 'upsert', 'loadOne'] as const)(
    'retains the displayed branch when a page receives complete %s authority',
    async (delivery) => {
      const original = createLinearConversationGraph({
        sessionId: request.sessionId,
        messages: [message('original', 1)],
        createdAt: 1,
        updatedAt: 1
      })
      const edited = synchronizeActiveConversationMessages(
        forkEditedConversationMessage(original, 'original', 'edited-branch', 2),
        [message('revised', 2)],
        2
      )
      const remoteGraph = activateConversationBranch(edited, original.branches[0]!.id)
      const authority = {
        ...session(resolveActiveConversationMessages(remoteGraph).map(projectConversationMessage)),
        revision: 5,
        conversationGraph: remoteGraph
      }
      const api = {
        loadHistoryPage: vi.fn().mockResolvedValue(
          page({
            messageBranchId: 'edited-branch',
            session: session(
              resolveActiveConversationMessages(edited).map(projectConversationMessage)
            )
          })
        ),
        loadOne: vi.fn().mockResolvedValue(authority)
      }
      await loadSessionHistoryPage(request, false, api)
      if (delivery === 'loadOne') await ensureSessionContentLoaded(request, api)
      else if (delivery === 'upsert') useSessionStore.getState().upsertPersistedSession(authority)
      else
        useSessionStore.getState().applyDurableSessionProjection({
          source: current(),
          session: authority,
          mode: 'runtime-transcript-authority'
        })
      // The ordinary lifecycle echo and later rename must not switch this window either.
      useSessionStore.getState().upsertPersistedSession(authority)
      useSessionStore.getState().applyDurableSessionProjection({
        source: current(),
        session: { ...authority, revision: 6, title: 'Remote rename' },
        mode: 'session-details-authority'
      })
      expect(current().messages.map(({ id }) => id)).toEqual(['revised'])
      expect(current().conversationGraph?.frames[0].activeBranchId).toBe('edited-branch')
      expect(current().title).toBe('Remote rename')
      expect(current().contentLoaded).toBeUndefined()
      expect(current().historyPage).toBeUndefined()
      expect(toPersistedSession(current()).conversationGraph?.messages.map(({ id }) => id)).toEqual(
        ['original', 'revised']
      )
    }
  )

  it('keeps the displayed parent frame when complete authority selects its visible child', async () => {
    const authority = materializeSessionConversationGraph(session([message('parent', 1)]))
    const graph = authority.conversationGraph!
    const parentBranch = graph.branches[0]!.id
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: 'parent',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 2
    })
    graph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      createdAt: 2,
      updatedAt: 2
    })
    graph.activeFrameId = 'child-frame'
    authority.messages = []
    const api = {
      loadHistoryPage: vi
        .fn()
        .mockResolvedValue(
          page({ messageBranchId: parentBranch, session: session([message('parent', 1)]) })
        ),
      loadOne: vi.fn().mockResolvedValue(authority)
    }
    await loadSessionHistoryPage(request, false, api)
    await ensureSessionContentLoaded(request, api)
    expect(current().conversationGraph?.activeFrameId).toBe(graph.rootFrameId)
    expect(current().conversationGraph?.frames).toHaveLength(2)
    expect(current().messages.map(({ id }) => id)).toEqual(['parent'])
  })

  it.each(['missing', 'hidden-child', 'legacy-response'] as const)(
    'uses the complete authority when the display scope is %s',
    async (scope) => {
      const original = createLinearConversationGraph({
        sessionId: request.sessionId,
        messages: [message('original', 1)],
        createdAt: 1,
        updatedAt: 1
      })
      const graph = synchronizeActiveConversationMessages(
        forkEditedConversationMessage(original, 'original', 'current-branch', 5),
        [message('current', 5)],
        5
      )
      graph.frames.push({
        id: 'child-frame',
        parentFrameId: graph.rootFrameId,
        originMessageId: 'original',
        originBindingState: 'validated',
        kind: 'delegate',
        status: 'completed',
        activeBranchId: 'child-branch',
        createdAt: 2
      })
      graph.branches.push({
        id: 'child-branch',
        agentFrameId: 'child-frame',
        createdAt: 2,
        updatedAt: 2
      })
      const authority = { ...session([message('current', 5)]), conversationGraph: graph }
      await loadSessionHistoryPage(request, false, {
        loadHistoryPage: vi.fn().mockResolvedValue(
          page({
            messageBranchId:
              scope === 'legacy-response'
                ? undefined
                : scope === 'hidden-child'
                  ? 'child-branch'
                  : 'removed-branch',
            session: session([message('removed', 1)])
          })
        ),
        loadOne: vi.fn()
      })
      useSessionStore.getState().applyDurableSessionProjection({
        source: current(),
        session: { ...authority, revision: 5 },
        mode: 'runtime-transcript-authority'
      })
      expect(current().messages.map(({ id }) => id)).toEqual(['current'])
      expect(current().conversationGraph).toEqual(authority.conversationGraph)
      expect(current().contentLoaded).toBeUndefined()
      expect(current().historyPage).toBeUndefined()
    }
  )

  it.each([undefined, true] as const)(
    'reports a stale first page after a metadata receipt and permits retry (complete: %s)',
    async (complete) => {
      let resolvePage!: (value: SessionHistoryPage) => void
      const api = {
        loadHistoryPage: vi.fn().mockImplementationOnce(
          () =>
            new Promise<SessionHistoryPage>((resolve) => {
              resolvePage = resolve
            })
        ),
        loadOne: vi.fn()
      }
      const loading = loadSessionHistoryPage(request, false, api)
      applySessionMetadataReceipt(
        current(),
        {
          id: request.sessionId,
          projectId: request.projectId,
          revision: 5,
          updatedAt: 5,
          title: 'Renamed while loading',
          pinned: false
        },
        ['title']
      )
      resolvePage(page({ complete }))
      await expect(loading).rejects.toMatchObject({ code: SESSION_HISTORY_CURSOR_STALE })
      expect(current()).toMatchObject({
        title: 'Renamed while loading',
        revision: 5,
        contentLoaded: false,
        messages: []
      })
      expect(current().historyPage).toBeUndefined()

      api.loadHistoryPage.mockResolvedValueOnce(
        page({
          revision: 5,
          session: { ...session(), title: 'Renamed while loading', revision: 5 }
        })
      )
      await loadSessionHistoryPage(request, false, api)
      expect(current().historyPage?.revision).toBe(5)
      expect(current().messages.map(({ id }) => id)).toEqual(['newest'])
      expect(current().title).toBe('Renamed while loading')
      expect(api.loadHistoryPage).toHaveBeenCalledTimes(2)
      expect(api.loadOne).not.toHaveBeenCalled()
    }
  )

  it.each(['idle', 'running'] as const)(
    'installs a complete %s response with its graph and avoids any later authority reload',
    async (status) => {
      const authority = materializeSessionConversationGraph({
        ...session([message('old', 1), message('newest', 3)]),
        status
      })
      let resolvePage!: (value: SessionHistoryPage) => void
      const api = {
        loadHistoryPage: vi.fn(
          () =>
            new Promise<SessionHistoryPage>((resolve) => {
              resolvePage = resolve
            })
        ),
        loadOne: vi.fn()
      }
      const loading = loadSessionHistoryPage(request, false, api)
      useSessionStore.setState({
        sessions: [
          { ...current(), title: 'Locally renamed', pinned: true, number: 9, unsavedTitle: true }
        ]
      })
      resolvePage(
        page({
          complete: true,
          session: authority,
          totalItems: 2,
          hasMore: false,
          beforeCursor: undefined
        })
      )
      await loading
      expect(current()).toMatchObject({
        title: 'Locally renamed',
        pinned: true,
        number: 9,
        unsavedTitle: true
      })
      expect(current().contentLoaded).toBeUndefined()
      expect(current().historyPage).toBeUndefined()
      expect(current().conversationGraph).toEqual(authority.conversationGraph)
      expect(toPersistedSession(current()).messages).toEqual(authority.messages)
      await ensureSessionContentLoaded(request, api)
      await loadSessionHistoryPage(request, true, api)
      expect(api.loadHistoryPage).toHaveBeenCalledOnce()
      expect(api.loadOne).not.toHaveBeenCalled()
    }
  )

  it('uses full authority for a live session before applying runtime state', async () => {
    useSessionStore.setState({ sessions: [{ ...current(), status: 'running' }] })
    const api = {
      loadHistoryPage: vi.fn(),
      loadOne: vi.fn().mockResolvedValue({ ...session(), status: 'running' })
    }
    await loadSessionHistoryPage(request, false, api)
    expect(api.loadHistoryPage).not.toHaveBeenCalled()
    expect(api.loadOne).toHaveBeenCalledOnce()
    expect(current().contentLoaded).toBeUndefined()
  })

  it('loads a page without loadOne or a save and rejects treating it as authority', async () => {
    const api = {
      loadHistoryPage: vi.fn().mockResolvedValue(page()),
      loadOne: vi.fn(),
      loadAll: vi.fn(),
      saveSession: vi.fn(),
      saveManifest: vi.fn(),
      deleteSession: vi.fn()
    }
    const save = createStoreSaver(api)
    await loadSessionHistoryPage(request, false, api)
    await save(useSessionStore.getState())
    expect(current().messages.map(({ id }) => id)).toEqual(['newest'])
    expect(current().contentLoaded).toBe(false)
    expect(() => toPersistedSession(current())).toThrow('must be loaded')
    expect(api.loadOne).not.toHaveBeenCalled()
    expect(api.saveSession).not.toHaveBeenCalled()
  })

  it('acknowledges a complete response as a read rather than saving it again', async () => {
    const authority = materializeSessionConversationGraph(session())
    const api = {
      loadHistoryPage: vi
        .fn()
        .mockResolvedValue(
          page({ complete: true, session: authority, hasMore: false, beforeCursor: undefined })
        ),
      loadOne: vi.fn(),
      loadAll: vi.fn(),
      saveSession: vi.fn(),
      rename: vi.fn(),
      setPinned: vi.fn(),
      saveManifest: vi.fn(),
      deleteSession: vi.fn()
    }
    const save = createStoreSaver(api)
    await loadSessionHistoryPage(request, false, api)
    await save(useSessionStore.getState())
    expect(toPersistedSession(current()).conversationGraph).toEqual(authority.conversationGraph)
    expect(api.loadOne).not.toHaveBeenCalled()
    expect(api.saveSession).not.toHaveBeenCalled()
    expect(api.rename).not.toHaveBeenCalled()
    expect(api.setPinned).not.toHaveBeenCalled()
  })

  it('prepends complete records, deduplicates prompt context and merges activity groups', async () => {
    const tool = (id: string, createdAt: number): PersistedToolActivity => ({
      id,
      createdAt,
      updatedAt: createdAt,
      kind: 'tool' as const,
      title: id,
      status: 'completed' as const,
      sortIndex: createdAt,
      eventIds: [],
      toolContent: [
        {
          type: 'content' as const,
          content: { type: 'text' as const, text: 'complete result'.repeat(100) }
        }
      ]
    })
    const api = {
      loadHistoryPage: vi
        .fn()
        .mockResolvedValueOnce(
          page({
            session: {
              ...session([message('prompt', 1), message('newest', 3)]),
              activities: [tool('later-tool', 3)],
              artifacts: [
                { id: 'new-artifact', kind: 'external-file', path: '/workspace/new.txt' }
              ],
              activityGroups: [
                {
                  id: 'group',
                  title: 'Tools',
                  sortIndex: 1,
                  activityIds: ['later-tool'],
                  createdAt: 1,
                  updatedAt: 3
                }
              ]
            }
          })
        )
        .mockResolvedValueOnce(
          page({
            hasMore: false,
            beforeCursor: undefined,
            session: {
              ...session([message('prompt', 1), message('middle', 2)]),
              activities: [tool('earlier-tool', 2)],
              artifacts: [
                { id: 'old-artifact', kind: 'external-file', path: '/workspace/old.txt' }
              ],
              activityGroups: [
                {
                  id: 'group',
                  title: 'Tools',
                  sortIndex: 1,
                  activityIds: ['earlier-tool'],
                  createdAt: 1,
                  updatedAt: 3
                }
              ]
            }
          })
        ),
      loadOne: vi.fn()
    }
    await loadSessionHistoryPage(request, false, api)
    await loadSessionHistoryPage(request, true, api)
    expect(api.loadHistoryPage).toHaveBeenLastCalledWith({ ...request, beforeCursor: 'older' })
    expect(current().messages.map(({ id }) => id)).toEqual(['prompt', 'middle', 'newest'])
    expect(current().activities?.map(({ id }) => id)).toEqual(['earlier-tool', 'later-tool'])
    expect(current().activityGroups?.[0].activityIds).toEqual(['earlier-tool', 'later-tool'])
    expect(current().activities?.[0].toolContent).toEqual(tool('earlier-tool', 2).toolContent)
    expect(current().artifacts?.map(({ id }) => id)).toEqual(['old-artifact', 'new-artifact'])
    expect(current().contentLoaded).toBe(false)
    expect(current().historyPage?.hasMore).toBe(false)
    expect(() => toPersistedSession(current())).toThrow('must be loaded')
  })

  it.each(['code', 'message'])(
    'restarts at the latest page on a stale %s cursor',
    async (transport) => {
      const api = {
        loadHistoryPage: vi
          .fn()
          .mockResolvedValueOnce(page())
          .mockRejectedValueOnce(
            transport === 'code'
              ? { code: SESSION_HISTORY_CURSOR_STALE }
              : new Error(SESSION_HISTORY_CURSOR_STALE)
          )
          .mockResolvedValueOnce(
            page({ revision: 5, session: { ...session([message('replacement', 5)]), revision: 5 } })
          ),
        loadOne: vi.fn()
      }
      await loadSessionHistoryPage(request, false, api)
      await loadSessionHistoryPage(request, true, api)
      expect(current().messages.map(({ id }) => id)).toEqual(['replacement'])
      expect(current().historyPage?.revision).toBe(5)
      expect(api.loadHistoryPage).toHaveBeenLastCalledWith({ ...request, limit: 8 })
    }
  )

  it.each([undefined, true] as const)(
    'upgrades to complete authority before mutation and ignores a late page (complete: %s)',
    async (complete) => {
      let resolvePage!: (value: SessionHistoryPage) => void
      const authority = materializeSessionConversationGraph(
        session([message('old', 1), message('newest', 3)])
      )
      const api = {
        loadHistoryPage: vi.fn(
          () =>
            new Promise<SessionHistoryPage>((resolve) => {
              resolvePage = resolve
            })
        ),
        loadOne: vi.fn().mockResolvedValue(authority)
      }
      const loading = loadSessionHistoryPage(request, false, api)
      await Promise.all([
        ensureSessionContentLoaded(request, api),
        ensureSessionContentLoaded(request, api)
      ])
      expect(api.loadOne).toHaveBeenCalledTimes(1)
      resolvePage(page({ complete }))
      await loading
      expect(current().contentLoaded).toBeUndefined()
      expect(current().historyPage).toBeUndefined()
      expect(current().conversationGraph).toEqual(authority.conversationGraph)
      expect(toPersistedSession(current()).messages.map(({ id }) => id)).toEqual(['old', 'newest'])
    }
  )

  it('does not turn a failed full load into writable partial history', async () => {
    const api = {
      loadHistoryPage: vi.fn().mockResolvedValue(page()),
      loadOne: vi.fn().mockRejectedValue(new Error('offline'))
    }
    await loadSessionHistoryPage(request, false, api)
    await expect(ensureSessionContentLoaded(request, api)).rejects.toThrow('offline')
    expect(() => toPersistedSession(current())).toThrow('must be loaded')
  })
})
