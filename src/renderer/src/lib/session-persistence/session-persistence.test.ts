import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  SESSION_MANIFEST_VERSION,
  SessionRevisionConflictError,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type SessionSummary
} from '../../../../shared/session-persistence'
import { toRuntimeUploadedAttachment } from '../../../../shared/uploads'
import {
  createInitialSessionState,
  isExternallyHydratedSession,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import {
  createOrderedSessionPersistence,
  createStoreSaver,
  flushSessionPersistence,
  loadPersistedSession,
  loadPersistedSessions,
  reconcilePendingArtifacts,
  saveSessionInOrder,
  type SessionPersistenceApi
} from './session-persistence'

const createPersistedSession = (
  overrides: Partial<PersistedChatSession> = {}
): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Restored',
  cwd: '/workspace/project',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createLoadResult = (
  sessions: PersistedChatSession[] = [createPersistedSession()],
  lastSessionId: string | undefined = 'session-1'
): LoadAllSessionsResult => ({
  sessions,
  manifest: { version: SESSION_MANIFEST_VERSION, lastSessionId }
})

const createApi = (overrides: Partial<SessionPersistenceApi> = {}): SessionPersistenceApi => ({
  loadAll: vi.fn().mockResolvedValue(createLoadResult()),
  loadOne: vi.fn().mockResolvedValue(undefined),
  saveSession: vi.fn(async (session: PersistedChatSession) => session),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  saveManifest: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

beforeEach(() => {
  useSessionStore.setState(createInitialSessionState())
})

describe('reconcilePendingArtifacts', () => {
  it('re-finalizes a crash-orphaned pending artifact and replaces the message references', async () => {
    const pendingPath = '/data/artifacts/proj-1/artifact-session/.pending/run-1/chart.png'
    useSessionStore.getState().hydrateSessions([
      createPersistedSession({
        id: 'session-1',
        projectId: 'proj-1',
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'done',
            status: 'complete',
            eventIds: [],
            artifactIds: ['artifact-session:run-1:chart.png'],
            createdAt: 1710000000000,
            updatedAt: 1710000000000
          }
        ],
        artifacts: [
          {
            id: 'artifact-session:run-1:chart.png',
            kind: 'managed-file',
            path: pendingPath,
            name: 'chart.png',
            mimeType: 'image/png'
          }
        ]
      })
    ])

    const finalized = {
      id: 'session-1:message-1:chart.png',
      projectId: 'proj-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      name: 'chart.png',
      path: '/data/artifacts/proj-1/session-1/message-1/chart.png',
      fileUrl: 'file:///data/artifacts/proj-1/session-1/message-1/chart.png',
      mimeType: 'image/png',
      size: 3,
      mtimeMs: 1710000000000
    }
    const api = { reconcilePendingArtifacts: vi.fn().mockResolvedValue([finalized]) }

    await reconcilePendingArtifacts(api)

    expect(api.reconcilePendingArtifacts).toHaveBeenCalledWith({
      projectId: 'proj-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      pendingPaths: [pendingPath]
    })

    const session = useSessionStore.getState().sessions.find((item) => item.id === 'session-1')
    expect(session?.messages[0].artifactIds).toEqual(['session-1:message-1:chart.png'])
    expect(session?.artifacts?.map((artifact) => artifact.path)).toEqual([finalized.path])
  })

  it('leaves messages without pending artifacts untouched', async () => {
    useSessionStore.getState().hydrateSessions([createPersistedSession({ id: 'session-1' })])
    const api = { reconcilePendingArtifacts: vi.fn() }

    await reconcilePendingArtifacts(api)

    expect(api.reconcilePendingArtifacts).not.toHaveBeenCalled()
  })

  it('re-finalizes pending artifacts referenced only by an inactive conversation Branch', async () => {
    const pendingPath = '/data/artifacts/proj-1/session-1/.pending/run-1/report.md'
    const originalPrompt = {
      id: 'original-prompt',
      role: 'user' as const,
      content: 'Create a report',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1710000000000,
      updatedAt: 1710000000000
    }
    const originalAnswer = {
      id: 'inactive-answer',
      role: 'agent' as const,
      content: 'done',
      status: 'complete' as const,
      eventIds: [],
      artifactIds: ['session-1:run-1:report.md'],
      createdAt: 1710000000001,
      updatedAt: 1710000000001
    }
    const originalGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [originalPrompt, originalAnswer],
      createdAt: 1710000000000,
      updatedAt: 1710000000001
    })
    const revisedPrompt = {
      ...originalPrompt,
      id: 'revised-prompt',
      content: 'Create a chart'
    }
    const conversationGraph = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(
        originalGraph,
        originalPrompt.id,
        'revised-branch',
        1710000000002
      ),
      [revisedPrompt],
      1710000000003
    )
    useSessionStore.getState().hydrateSessions([
      createPersistedSession({
        id: 'session-1',
        projectId: 'proj-1',
        messages: [revisedPrompt],
        conversationGraph,
        artifacts: [
          {
            id: 'session-1:run-1:report.md',
            kind: 'managed-file',
            path: pendingPath,
            name: 'report.md',
            mimeType: 'text/markdown'
          }
        ]
      })
    ])
    const finalized = {
      id: 'session-1:inactive-answer:report.md',
      projectId: 'proj-1',
      sessionId: 'session-1',
      messageId: originalAnswer.id,
      name: 'report.md',
      path: '/data/artifacts/proj-1/session-1/inactive-answer/report.md',
      fileUrl: 'file:///data/artifacts/proj-1/session-1/inactive-answer/report.md',
      mimeType: 'text/markdown',
      size: 3,
      mtimeMs: 1710000000004
    }
    const api = { reconcilePendingArtifacts: vi.fn().mockResolvedValue([finalized]) }

    await reconcilePendingArtifacts(api)

    expect(api.reconcilePendingArtifacts).toHaveBeenCalledWith({
      projectId: 'proj-1',
      sessionId: 'session-1',
      messageId: originalAnswer.id,
      pendingPaths: [pendingPath]
    })
    const restored = useSessionStore.getState().sessions[0]
    expect(restored.messages.map(({ id }) => id)).toEqual([revisedPrompt.id])
    expect(
      restored.conversationGraph?.messages.find(({ id }) => id === originalAnswer.id)?.artifactIds
    ).toEqual([finalized.id])
    expect(restored.artifacts?.map(({ path }) => path)).toEqual([finalized.path])
  })
})

describe('renderer session persistence bridge', () => {
  it('falls back to the existing Web load-all path when load-one is unavailable', async () => {
    const selected = createPersistedSession({ id: 'session-1', projectId: 'project-1' })
    const loadAll = vi.fn().mockResolvedValue(createLoadResult([selected]))

    await expect(
      loadPersistedSession({ projectId: selected.projectId, sessionId: selected.id }, { loadAll })
    ).resolves.toEqual(selected)
    expect(loadAll).toHaveBeenCalledOnce()
  })

  it('hydrates the store from the per-session load result', async () => {
    const api = createApi()

    await loadPersistedSessions(api)

    expect(api.loadAll).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ id: 'session-1' })
    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
  })

  it('hydrates the SQLite summary list without opening Session JSON', async () => {
    const list = vi.fn().mockResolvedValue({
      sessions: [
        {
          number: 1,
          id: 'session-1',
          projectId: 'project-1',
          title: 'Selected',
          status: 'idle',
          presentedStatus: 'idle',
          pinned: false,
          revision: 1,
          activeMessageCount: 0,
          artifactCount: 0,
          filesRevision: 0,
          createdAt: 1,
          updatedAt: 2,
          needsStartupRecovery: false
        },
        {
          number: 2,
          id: 'session-2',
          projectId: 'project-1',
          title: 'Unopened',
          status: 'idle',
          presentedStatus: 'idle',
          pinned: false,
          revision: 1,
          activeMessageCount: 12,
          artifactCount: 3,
          filesRevision: 2,
          createdAt: 2,
          updatedAt: 1,
          needsStartupRecovery: false
        }
      ],
      manifest: { version: SESSION_MANIFEST_VERSION, lastSessionId: 'session-1' }
    })
    const loadOne = vi.fn().mockResolvedValue(undefined)
    const api = createApi({ list, loadOne })

    await loadPersistedSessions(api)

    expect(api.loadAll).not.toHaveBeenCalled()
    expect(loadOne).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toMatchObject([
      { id: 'session-1', contentLoaded: false, messages: [] },
      { id: 'session-2', contentLoaded: false, activeMessageCount: 12, messages: [] }
    ])
  })

  it('also hydrates unopened Sessions that require startup recovery', async () => {
    const selected = createPersistedSession({ id: 'session-1', projectId: 'project-1' })
    const recovering = createPersistedSession({ id: 'session-2', projectId: 'project-1' })
    const summary = (
      session: PersistedChatSession,
      needsStartupRecovery: boolean
    ): SessionSummary => ({
      number: session.id === selected.id ? 1 : 2,
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      status: session.status,
      presentedStatus: session.status,
      pinned: false,
      revision: 1,
      activeMessageCount: session.messages.length,
      artifactCount: session.artifacts?.length ?? 0,
      filesRevision: 0,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      needsStartupRecovery
    })
    const list = vi.fn().mockResolvedValue({
      sessions: [summary(selected, false), summary(recovering, true)],
      manifest: { version: SESSION_MANIFEST_VERSION, lastSessionId: selected.id }
    })
    const loadOne = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === selected.id ? selected : recovering
    )

    await loadPersistedSessions(createApi({ list, loadOne }))

    expect(loadOne).toHaveBeenCalledOnce()
    expect(loadOne).toHaveBeenCalledWith({
      projectId: recovering.projectId,
      sessionId: recovering.id
    })
    expect(useSessionStore.getState().sessions).toMatchObject([
      { id: selected.id, contentLoaded: false },
      { id: recovering.id }
    ])
    expect(useSessionStore.getState().sessions[1]?.contentLoaded).not.toBe(false)
  })

  it('opens the explicitly selected Session again during a recovery retry', async () => {
    const selected = createPersistedSession({ id: 'session-1', projectId: 'project-1' })
    const list = vi.fn().mockResolvedValue({
      sessions: [
        {
          number: 1,
          id: selected.id,
          projectId: selected.projectId,
          title: selected.title,
          status: selected.status,
          presentedStatus: selected.status,
          pinned: false,
          revision: 1,
          activeMessageCount: selected.messages.length,
          artifactCount: 0,
          filesRevision: 0,
          createdAt: selected.createdAt,
          updatedAt: selected.updatedAt,
          needsStartupRecovery: false
        }
      ],
      manifest: { version: SESSION_MANIFEST_VERSION, lastSessionId: selected.id }
    })
    const loadOne = vi.fn().mockResolvedValue(selected)

    await loadPersistedSessions(createApi({ list, loadOne }), () => true, {
      sessionId: selected.id
    })

    expect(loadOne).toHaveBeenCalledWith({ projectId: selected.projectId, sessionId: selected.id })
    expect(useSessionStore.getState().sessions[0]?.contentLoaded).not.toBe(false)
  })

  it('does not hydrate a recovery Session after its startup JSON load is cancelled', async () => {
    const selected = createPersistedSession({ id: 'session-1', projectId: 'project-1' })
    const lazyLoad = createDeferred<PersistedChatSession | undefined>()
    const api = createApi({
      list: vi.fn().mockResolvedValue({
        sessions: [
          {
            number: 1,
            id: selected.id,
            projectId: selected.projectId,
            title: selected.title,
            status: 'idle',
            presentedStatus: 'idle',
            pinned: false,
            revision: 1,
            activeMessageCount: 0,
            artifactCount: 0,
            filesRevision: 0,
            createdAt: 1,
            updatedAt: 2,
            needsStartupRecovery: true
          }
        ],
        manifest: { version: SESSION_MANIFEST_VERSION, lastSessionId: selected.id }
      }),
      loadOne: vi.fn(() => lazyLoad.promise)
    })
    let active = true

    const loading = loadPersistedSessions(api, () => active)
    await vi.waitFor(() => expect(api.loadOne).toHaveBeenCalledOnce())
    active = false
    lazyLoad.resolve(selected)
    await loading

    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('loads authority before persisting metadata edits to an unopened Session', async () => {
    const authority = createPersistedSession({
      id: 'session-2',
      projectId: 'project-1',
      pinned: true,
      updatedAt: 2_000_000_000_000
    })
    useSessionStore.getState().hydrateSessionSummaries(
      [
        {
          number: 2,
          id: authority.id,
          projectId: authority.projectId,
          title: authority.title,
          status: 'idle',
          presentedStatus: 'idle',
          pinned: false,
          revision: 0,
          activeMessageCount: 0,
          artifactCount: 0,
          filesRevision: 0,
          createdAt: authority.createdAt,
          updatedAt: authority.updatedAt,
          needsStartupRecovery: false
        }
      ],
      undefined
    )
    const loadOne = vi.fn().mockResolvedValue(authority)
    const saveSession = vi.fn(async (session: PersistedChatSession) => session)
    const api = createApi({ loadOne, saveSession })
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().renameSession(authority.id, 'Renamed while unopened')
    await save(useSessionStore.getState())

    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-2' })
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-2',
        title: 'Renamed while unopened',
        pinned: true,
        updatedAt: authority.updatedAt
      }),
      { conflictRebaseFields: ['title'] }
    )
    expect(useSessionStore.getState().sessions[0]?.contentLoaded).not.toBe(false)
  })

  it('does not hydrate a session snapshot after its startup effect is cancelled', async () => {
    const deferred = createDeferred<LoadAllSessionsResult>()
    const api = createApi({ loadAll: vi.fn().mockReturnValue(deferred.promise) })
    const load = loadPersistedSessions(api, () => false)

    deferred.resolve(createLoadResult())
    await load

    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('keeps selection empty when a retry target no longer exists', async () => {
    const manifestSession = createPersistedSession({ id: 'manifest-session' })
    const observedSelections: Array<string | undefined> = []
    const unsubscribe = useSessionStore.subscribe((state) => {
      observedSelections.push(state.selectedSessionId)
    })
    const api = createApi({
      loadAll: vi.fn().mockResolvedValue(createLoadResult([manifestSession], manifestSession.id))
    })

    try {
      await loadPersistedSessions(api, () => true, { sessionId: 'deleted-session' })
    } finally {
      unsubscribe()
    }

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(observedSelections).toEqual([undefined])
  })

  it('does not echo an externally hydrated session back to persistence', async () => {
    const api = createApi()
    const save = createStoreSaver(api)

    useSessionStore.getState().upsertPersistedSession(createPersistedSession())
    await save(useSessionStore.getState())

    expect(api.saveSession).not.toHaveBeenCalled()
  })

  it('saves only the session whose reference changed', async () => {
    const api = createApi()
    const save = createStoreSaver(api)

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })

    await save(useSessionStore.getState())

    expect(api.saveSession).toHaveBeenCalledTimes(1)
    expect(api.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', projectId: 'project-a' })
    )
  })

  it('reports only changed safe fields for stale-graph conflict rebasing', async () => {
    const persisted = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        title: 'Original',
        pinned: false,
        messages: [
          {
            id: 'stale-message',
            role: 'user',
            content: 'Stale graph',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const durable = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        title: 'Local rename',
        pinned: true,
        messages: [
          {
            id: 'durable-message',
            role: 'agent',
            content: 'Artifact finalized',
            status: 'complete',
            eventIds: [],
            createdAt: 2,
            updatedAt: 2
          }
        ],
        updatedAt: 2
      })
    )
    useSessionStore.getState().hydrateSessions([persisted])
    const api = createApi({ saveSession: vi.fn().mockResolvedValue(durable) })
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().renameSession('session-1', 'Local rename')
    useSessionStore.getState().togglePinned('session-1')
    await save(useSessionStore.getState())

    expect(api.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Local rename', pinned: true }),
      { conflictRebaseFields: ['title', 'pinned'] }
    )
    expect(useSessionStore.getState().sessions[0].messages).toEqual(durable.messages)
    expect(useSessionStore.getState().sessions[0].conversationGraph).toEqual(
      durable.conversationGraph
    )
  })

  it('preserves first-output waiting when a durable conflict projection replaces the session', async () => {
    const persisted = createPersistedSession({
      projectId: 'project-a',
      title: 'Original'
    })
    const durable = createPersistedSession({
      projectId: 'project-a',
      title: 'Local rename',
      updatedAt: persisted.updatedAt + 1
    })
    useSessionStore.getState().hydrateSessions([persisted])
    const api = createApi({ saveSession: vi.fn().mockResolvedValue(durable) })
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().renameSession('session-1', 'Local rename')
    useSessionStore.getState().setAwaitingFirstAgentOutput('session-1', true)
    await save(useSessionStore.getState())

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBe(true)
  })

  it('retains safe-field rebase intent for a forced retry after a failed write', async () => {
    const persisted = createPersistedSession({ projectId: 'project-a', title: 'Original' })
    useSessionStore.getState().hydrateSessions([persisted])
    const saveSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockImplementation(async (session: PersistedChatSession) => session)
    const failedFields = new Map<string, readonly ['title']>()
    const api = createApi({ saveSession })
    const save = createStoreSaver(api, useSessionStore.getState(), {
      onFailure: (target, _error, context) => {
        if (context.conflictRebaseFields?.includes('title')) {
          failedFields.set(target, ['title'])
        }
      }
    })

    useSessionStore.getState().renameSession('session-1', 'Local rename')
    const state = useSessionStore.getState()
    await expect(save(state)).rejects.toThrow('database busy')
    await save(state, {
      forceTargets: new Set(['session:session-1']),
      conflictRebaseFieldsByTarget: failedFields
    })

    expect(saveSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Local rename' }),
      { conflictRebaseFields: ['title'] }
    )
  })

  it('recovers a forced revision conflict without re-entering the ordered save queue', async () => {
    const persisted = materializeSessionConversationGraph(
      createPersistedSession({ projectId: 'project-a', revision: 1, title: 'Original' })
    )
    useSessionStore.getState().hydrateSessions([persisted])
    const durableBase = toPersistedSession(useSessionStore.getState().sessions[0])
    const remoteMessage = {
      id: 'remote-message',
      role: 'agent' as const,
      content: 'Saved in another window',
      status: 'complete' as const,
      eventIds: [],
      createdAt: persisted.updatedAt + 1,
      updatedAt: persisted.updatedAt + 1
    }
    const authoritative = materializeSessionConversationGraph({
      ...durableBase,
      revision: 2,
      messages: [remoteMessage],
      updatedAt: persisted.updatedAt + 1
    })
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(1, 2))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 3 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().renameSession('session-1', 'Local rename')
    await expect(
      save(useSessionStore.getState(), {
        forceTargets: new Set(['session:session-1'])
      })
    ).resolves.toBeUndefined()

    expect(saveSession).toHaveBeenCalledTimes(2)
    expect(saveSession.mock.calls[1]).toEqual([
      expect.objectContaining({ revision: 2, title: 'Local rename' }),
      { conflictRebaseFields: ['title'] }
    ])
    expect(useSessionStore.getState().sessions[0].messages).toEqual([remoteMessage])
    expect(useSessionStore.getState().sessions[0].conversationGraph?.messages).toEqual([
      expect.objectContaining(remoteMessage)
    ])
  })

  it('does not persist unbound pending sessions', async () => {
    const api = createApi()
    const save = createStoreSaver(api)

    useSessionStore.getState().appendPendingUserMessage({
      content: 'Save after ACP creates the session',
      cwd: '/workspace/project'
    })

    await save(useSessionStore.getState())

    expect(api.saveSession).not.toHaveBeenCalled()
  })

  it('does not overwrite the last durable graph after terminal graph synchronization fails', async () => {
    const api = createApi()
    useSessionStore
      .getState()
      .hydrateSessions([createPersistedSession({ id: 'session-1', projectId: 'project-a' })])
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-1'
          ? {
              ...session,
              status: 'error',
              error: 'Conversation history could not be finalized safely.',
              conversationGraphSyncBlocked: true
            }
          : session
      )
    }))

    await save(useSessionStore.getState())

    expect(api.saveSession).not.toHaveBeenCalled()
  })

  it('waits for staged uploads to acquire an immutable Version before saving the Session', async () => {
    const api = createApi()
    const save = createStoreSaver(api)
    const appended = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Analyze this upload',
      cwd: '/workspace/project',
      projectId: 'project-a',
      attachments: [
        {
          id: 'upload-1',
          sessionId: '.pending',
          name: 'sample.csv',
          originalName: 'sample.csv',
          path: '/data/uploads/default-project/.pending/sample.csv',
          mimeType: 'text/csv',
          size: 12
        }
      ]
    })

    await save(useSessionStore.getState())
    expect(api.saveSession).not.toHaveBeenCalled()

    useSessionStore.getState().replaceMessageUploads({
      sessionId: 'session-1',
      messageId: appended?.messageId ?? '',
      uploads: [
        {
          id: 'upload-1',
          versionId: 'upload-version-1',
          versionNumber: 1,
          sessionId: 'session-1',
          name: 'sample.csv',
          originalName: 'sample.csv',
          mimeType: 'text/csv',
          size: 12,
          sha256: 'abc123'
        }
      ]
    })

    await save(useSessionStore.getState())
    expect(api.saveSession).toHaveBeenCalledOnce()
    expect(api.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            uploads: [expect.objectContaining({ versionId: 'upload-version-1' })]
          })
        ]
      })
    )
  })

  it('applies the path-free durable projection returned by a live save to the originating store', async () => {
    const legacyPath = '/data/uploads/default-project/session-1/legacy.csv'
    const legacySession = createPersistedSession({
      projectId: 'project-a',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Analyze this upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: legacyPath,
              size: 12
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useSessionStore.getState().hydrateSessions([legacySession])
    const saveSession = vi.fn(async (submitted: PersistedChatSession) => {
      const durable = structuredClone(submitted)
      const versionedUpload = {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'legacy.csv',
        originalName: 'legacy.csv',
        size: 12,
        sha256: 'a'.repeat(64)
      }
      durable.messages[0].uploads = [versionedUpload]
      const graphMessage = durable.conversationGraph?.messages.find(
        (message) => message.id === 'message-1'
      )
      if (graphMessage) graphMessage.uploads = [versionedUpload]
      return durable
    })
    const save = createStoreSaver(createApi({ saveSession }), useSessionStore.getState())

    useSessionStore.getState().renameSession('session-1', 'Persist upgraded upload')
    await save(useSessionStore.getState())

    const stored = useSessionStore.getState().sessions[0]
    const upload = stored.messages[0].uploads?.[0]
    expect(upload).toMatchObject({ id: 'upload-1', versionId: 'upload-version-1' })
    expect(upload).not.toHaveProperty('path')
    expect(toRuntimeUploadedAttachment(upload!, stored.projectId).path).toBe(
      'upload-version:project-a/session-1/upload-version-1'
    )
    expect(saveSession).toHaveBeenCalledOnce()
  })

  it('keeps the readable legacy projection in the live store when durable propagation fails', async () => {
    const legacyPath = '/data/uploads/default-project/session-1/legacy.csv'
    useSessionStore.getState().hydrateSessions([
      createPersistedSession({
        projectId: 'project-a',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            content: 'Analyze this upload',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                sessionId: 'session-1',
                name: 'legacy.csv',
                originalName: 'legacy.csv',
                path: legacyPath,
                size: 12
              }
            ],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    ])
    const save = createStoreSaver(
      createApi({ saveSession: vi.fn().mockRejectedValue(new Error('IPC propagation failed')) }),
      useSessionStore.getState()
    )

    useSessionStore.getState().renameSession('session-1', 'Save will fail')
    await expect(save(useSessionStore.getState())).rejects.toThrow('IPC propagation failed')

    const upload = useSessionStore.getState().sessions[0].messages[0].uploads?.[0]
    expect(upload).toMatchObject({ path: legacyPath })
    expect(upload).not.toHaveProperty('versionId')
  })

  it('merges a delayed durable Upload identity without overwriting a newer live message', () => {
    const legacyPath = '/data/uploads/default-project/session-1/legacy.csv'
    const persisted = createPersistedSession({
      projectId: 'project-a',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Analyze this upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: legacyPath,
              size: 12
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useSessionStore.getState().hydrateSessions([persisted])
    const source = useSessionStore.getState().sessions[0]
    const durable = structuredClone(persisted)
    durable.messages[0].uploads = [
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'legacy.csv',
        originalName: 'legacy.csv',
        size: 12,
        sha256: 'a'.repeat(64)
      }
    ]

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Newer live message',
      projectId: 'project-a'
    })
    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: durable,
      mode: 'replace-persisted-if-current'
    })

    const projected = useSessionStore.getState().sessions[0]
    expect(projected.messages.map((message) => message.content)).toEqual([
      'Analyze this upload',
      'Newer live message'
    ])
    expect(projected.messages[0].uploads?.[0]).toMatchObject({
      versionId: 'upload-version-1'
    })
    expect(
      projected.conversationGraph?.messages.find((message) => message.id === 'message-1')
        ?.uploads?.[0]
    ).toMatchObject({ versionId: 'upload-version-1' })
    expect(isExternallyHydratedSession(projected)).toBe(true)
  })

  it('accepts an equal-revision Upload Version from another lifecycle client', () => {
    const persisted = createPersistedSession({
      projectId: 'project-a',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Analyze this upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: '/data/uploads/default-project/session-1/legacy.csv',
              size: 12
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useSessionStore.getState().hydrateSessions([persisted])
    const durable = structuredClone(persisted)
    durable.messages[0].uploads = [
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'legacy.csv',
        originalName: 'legacy.csv',
        size: 12,
        sha256: 'a'.repeat(64)
      }
    ]

    useSessionStore.getState().upsertPersistedSession(durable)

    expect(useSessionStore.getState().sessions[0].messages[0].uploads?.[0]).toMatchObject({
      versionId: 'upload-version-1'
    })
  })

  it('does not infer durable deletion from sessions removed from the store', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })

    const api = createApi()
    // Baseline snapshot already contains session-1, so the next diff sees its removal.
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().deleteSession('session-1')

    await save(useSessionStore.getState())

    expect(api.deleteSession).not.toHaveBeenCalled()
  })

  it('writes the manifest when the selection changes to a persisted session', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })

    const api = createApi()
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-2',
      content: 'Second',
      cwd: '/workspace/project',
      projectId: 'project-b'
    })

    await save(useSessionStore.getState())

    expect(api.saveManifest).toHaveBeenCalledWith({
      lastSessionId: 'session-2',
      lastProjectId: 'project-b'
    })
  })

  it('queues writes so later snapshots do not resolve before earlier ones', async () => {
    const firstSave = createDeferred<PersistedChatSession>()
    const secondSave = createDeferred<PersistedChatSession>()
    const saveSession = vi
      .fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise)
    const api = createApi({ saveSession })

    // Select a session first so the baseline already knows the selection; later saves only change
    // content, keeping the queue free of interleaved manifest writes for this ordering assertion.
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Second',
      cwd: '/workspace/project'
    })
    void save(useSessionStore.getState())
    await flushMicrotasks()
    expect(saveSession).toHaveBeenCalledTimes(1)

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Third',
      cwd: '/workspace/project'
    })
    void save(useSessionStore.getState())

    await flushMicrotasks()
    expect(saveSession).toHaveBeenCalledTimes(1)

    firstSave.resolve(saveSession.mock.calls[0][0])
    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledTimes(2))

    secondSave.resolve(saveSession.mock.calls[1][0])
    await flushMicrotasks()
  })

  it('coalesces backpressured Store writes to the latest Session snapshot', async () => {
    const firstSave = createDeferred<void>()
    const saveSession = vi.fn<SessionPersistenceApi['saveSession']>(async (submitted) => {
      if (submitted.title === 'First queued') await firstSave.promise
      return submitted
    })
    const api = createApi({ saveSession })

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().renameSession('session-1', 'First queued')
    const first = save(useSessionStore.getState())
    await flushMicrotasks()

    useSessionStore.getState().renameSession('session-1', 'Latest')
    const renamed = save(useSessionStore.getState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Keep only this pending snapshot',
      cwd: '/workspace/project'
    })
    const latest = save(useSessionStore.getState())

    await flushMicrotasks()
    expect(saveSession).toHaveBeenCalledOnce()

    firstSave.resolve()
    await Promise.all([first, renamed, latest])

    expect(saveSession).toHaveBeenCalledTimes(2)
    expect(saveSession.mock.calls[1][0].title).toBe('Latest')
    expect(saveSession.mock.calls[1][1]).toEqual({ conflictRebaseFields: ['title'] })
  })

  it('chains queued local saves from the last acknowledged durable revision', async () => {
    const firstSave = createDeferred<PersistedChatSession>()
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 6 }))
    const api = createApi({ saveSession })

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })
    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: { ...toPersistedSession(source), revision: 4 }
    })
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().renameSession('session-1', 'First queued')
    const first = save(useSessionStore.getState())
    await flushMicrotasks()
    expect(saveSession.mock.calls[0][0].revision).toBe(4)

    useSessionStore.getState().renameSession('session-1', 'Second queued')
    const second = save(useSessionStore.getState())
    firstSave.resolve({ ...saveSession.mock.calls[0][0], revision: 5 })
    await Promise.all([first, second])

    expect(saveSession.mock.calls[1][0]).toMatchObject({
      revision: 5,
      title: 'Second queued'
    })
  })

  it('retries a local graph save over a concurrent main-owned permission revision', async () => {
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 1,
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Run the command',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const authoritative = {
      ...base,
      revision: 2,
      status: 'waiting-permission' as const,
      runtimeContext: {
        version: 1 as const,
        revision: 1,
        permission: {
          state: 'pending' as const,
          request: {
            requestId: 'permission-1',
            sessionId: base.id,
            toolCallId: 'tool-1',
            title: 'Run the command',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }]
          },
          originatingPromptMessageId: 'prompt-1',
          fingerprint: 'a'.repeat(64),
          createdAt: 2
        }
      },
      updatedAt: base.updatedAt + 1
    }
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(1, 2))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 3 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().appendUserMessage({
      sessionId: base.id,
      content: 'Keep this local graph update',
      cwd: base.cwd,
      projectId: base.projectId
    })

    await expect(save(useSessionStore.getState())).resolves.toBeUndefined()

    expect(api.loadOne).toHaveBeenCalledWith({ projectId: base.projectId, sessionId: base.id })
    expect(saveSession).toHaveBeenCalledTimes(2)
    expect(saveSession.mock.calls[1][0]).toMatchObject({
      revision: 2,
      status: 'waiting-permission',
      runtimeContext: authoritative.runtimeContext
    })
    expect(saveSession.mock.calls[1][0].messages.map(({ content }) => content)).toEqual([
      'Run the command',
      'Keep this local graph update'
    ])
  })

  it('retries local activity when Session details advance before a permission revision conflict', async () => {
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        status: 'running',
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Run the command',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ],
        sessionDetailsSource: 'fallback',
        sessionDetailsGeneration: {
          status: 'queued',
          sourceMessageId: 'prompt-1',
          requestId: 'prompt-1:session-details',
          queuedAt: 2
        }
      })
    )
    const runningDetails = {
      ...base,
      revision: 9,
      sessionDetailsGeneration: {
        ...base.sessionDetailsGeneration!,
        status: 'running' as const,
        startedAt: 3,
        frameworkId: 'opencode' as const,
        model: 'e2e-model',
        reasoningEffort: 'low' as const
      },
      updatedAt: base.updatedAt + 1
    }
    const permissionAuthority = {
      ...runningDetails,
      revision: 10,
      status: 'waiting-permission' as const,
      sessionDetailsGeneration: {
        ...runningDetails.sessionDetailsGeneration,
        status: 'failed' as const,
        completedAt: 4,
        usageUnavailable: true
      },
      runtimeContext: {
        version: 1 as const,
        revision: 1,
        permission: {
          state: 'pending' as const,
          request: {
            requestId: 'permission-1',
            sessionId: base.id,
            toolCallId: 'tool-1',
            title: 'Run the command',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }]
          },
          originatingPromptMessageId: 'prompt-1',
          fingerprint: 'a'.repeat(64),
          createdAt: 4
        }
      },
      updatedAt: runningDetails.updatedAt + 1
    }
    const firstSave = createDeferred<void>()
    const conflict = new SessionRevisionConflictError(8, 10)
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockImplementationOnce(async () => {
        await firstSave.promise
        throw conflict
      })
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 11 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(permissionAuthority),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().upsertToolActivity({
      sessionId: base.id,
      toolCallId: 'tool-1',
      eventId: 'tool-event-1',
      promptMessageId: 'prompt-1',
      title: 'Run the command',
      status: 'pending'
    })
    const savingLocalActivity = save(useSessionStore.getState())
    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledOnce())

    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: runningDetails,
      mode: 'session-details-authority'
    })
    await save(useSessionStore.getState())

    firstSave.resolve()
    await expect(savingLocalActivity).resolves.toBeUndefined()

    expect(saveSession).toHaveBeenCalledTimes(2)
    expect(saveSession.mock.calls[1][0]).toMatchObject({
      revision: 10,
      status: 'waiting-permission',
      sessionDetailsGeneration: { status: 'failed' },
      runtimeContext: permissionAuthority.runtimeContext,
      activities: [expect.objectContaining({ id: 'tool-1', status: 'pending' })]
    })
  })

  it('retries a pending tool activity save over disjoint concurrent Main graph changes', async () => {
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Run the notebook',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const authoritative = materializeSessionConversationGraph({
      ...base,
      revision: 9,
      status: 'waiting-permission' as const,
      messages: [
        ...base.messages,
        {
          id: 'main-relay-1',
          role: 'agent' as const,
          content: 'Main-owned relay update',
          status: 'complete' as const,
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      runtimeContext: {
        version: 1 as const,
        revision: 1,
        permission: {
          state: 'pending' as const,
          request: {
            requestId: 'permission-1',
            sessionId: base.id,
            toolCallId: 'tool-1',
            title: 'notebook_execute',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }]
          },
          originatingPromptMessageId: 'prompt-1',
          fingerprint: 'a'.repeat(64),
          createdAt: 2
        }
      },
      updatedAt: base.updatedAt + 1
    })
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(8, 9))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 10 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().upsertToolActivity({
      sessionId: base.id,
      toolCallId: 'tool-1',
      eventId: 'tool-event-1',
      promptMessageId: 'prompt-1',
      title: 'notebook_execute',
      status: 'pending'
    })

    await expect(save(useSessionStore.getState())).resolves.toBeUndefined()

    expect(saveSession).toHaveBeenCalledTimes(2)
    expect(saveSession.mock.calls[0][0]).toMatchObject({ revision: 8 })
    expect(saveSession.mock.calls[1][0]).toMatchObject({
      revision: 9,
      status: 'waiting-permission',
      runtimeContext: authoritative.runtimeContext,
      activities: [expect.objectContaining({ id: 'tool-1', status: 'pending' })]
    })
    expect(saveSession.mock.calls[1][0].messages).toEqual(authoritative.messages)
    expect(saveSession.mock.calls[1][0].conversationGraph?.messages.map(({ id }) => id)).toEqual([
      'prompt-1',
      'main-relay-1'
    ])
    expect(saveSession.mock.calls[1][0].conversationGraph?.activities.map(({ id }) => id)).toEqual([
      'tool-1'
    ])
  })

  it('reconciles a delivered Side chat relay with its already durable Main identity', async () => {
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Continue the main turn',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const relay = {
      id: 'side-chat-relay-1',
      role: 'user' as const,
      content: 'Use a black line.',
      status: 'complete' as const,
      eventIds: [] as string[],
      responseToMessageId: 'prompt-1',
      relayedFrom: { kind: 'side-chat' as const, direction: 'to-main' as const },
      createdAt: 2,
      updatedAt: 2
    }
    const authoritative = materializeSessionConversationGraph({
      ...base,
      revision: 9,
      messages: [...base.messages, relay],
      updatedAt: base.updatedAt + 1
    })
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(8, 9))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 10 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().appendRoutedUserMessage({
      sessionId: base.id,
      messageId: relay.id,
      eventId: `side-chat-delivered:${relay.id}`,
      content: relay.content,
      createdAt: relay.createdAt,
      responseToMessageId: relay.responseToMessageId,
      relayedFrom: relay.relayedFrom
    })

    await expect(save(useSessionStore.getState())).resolves.toBeUndefined()

    expect(saveSession).toHaveBeenCalledTimes(2)
    const rebased = saveSession.mock.calls[1][0]
    expect(rebased).toMatchObject({ revision: 9 })
    expect(rebased.messages).toContainEqual({
      ...relay,
      eventIds: [`side-chat-delivered:${relay.id}`]
    })
    const rebasedGraph = rebased.conversationGraph
    if (!rebasedGraph) throw new Error('Expected a rebased conversation graph.')
    expect(rebasedGraph.messages).toContainEqual(
      expect.objectContaining({
        ...relay,
        agentFrameId: rebasedGraph.rootFrameId,
        runtimeSegmentId: rebasedGraph.runtimeSegments[0].id,
        eventIds: [`side-chat-delivered:${relay.id}`]
      })
    )
  })

  it('projects an edit fork after rebasing a concurrent Main message onto the previous Branch', async () => {
    const target = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'Original prompt',
      status: 'complete' as const,
      eventIds: [] as string[],
      createdAt: 1,
      updatedAt: 1
    }
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        messages: [target]
      })
    )
    const remoteMessage = {
      id: 'remote-message-1',
      role: 'agent' as const,
      content: 'Completed on the original Branch',
      status: 'complete' as const,
      eventIds: [] as string[],
      responseToMessageId: target.id,
      createdAt: 2,
      updatedAt: 2
    }
    const authoritative = materializeSessionConversationGraph({
      ...base,
      revision: 9,
      messages: [...base.messages, remoteMessage],
      updatedAt: base.updatedAt + 1
    })
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(8, 9))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 10 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().removeMessage(base.id, target.id)

    await expect(save(useSessionStore.getState())).resolves.toBeUndefined()

    const rebased = saveSession.mock.calls[1][0]
    expect(rebased.messages).toEqual([])
    expect(rebased.conversationGraph?.messages.map(({ id }) => id)).toEqual([
      target.id,
      remoteMessage.id
    ])
    expect(() => materializeSessionConversationGraph(rebased)).not.toThrow()
  })

  it('projects the selected Branch after rebasing a concurrent Main message on the prior Branch', async () => {
    const originalPrompt = {
      id: 'prompt-original',
      role: 'user' as const,
      content: 'Original prompt',
      status: 'complete' as const,
      eventIds: [] as string[],
      createdAt: 1,
      updatedAt: 1
    }
    const linear = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        messages: [originalPrompt]
      })
    )
    const originalBranchId = linear.conversationGraph.branches[0].id
    const editedBranchId = 'edited-branch'
    const editedPrompt = {
      ...originalPrompt,
      id: 'prompt-edited',
      content: 'Edited prompt',
      createdAt: 2,
      updatedAt: 2
    }
    const editedGraph = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(linear.conversationGraph, originalPrompt.id, editedBranchId, 2),
      [editedPrompt],
      2
    )
    const base = {
      ...linear,
      conversationGraph: activateConversationBranch(editedGraph, originalBranchId),
      messages: [originalPrompt]
    }
    const remoteMessage = {
      id: 'remote-message-1',
      role: 'agent' as const,
      content: 'Completed on the original Branch',
      status: 'complete' as const,
      eventIds: [] as string[],
      responseToMessageId: originalPrompt.id,
      createdAt: 3,
      updatedAt: 3
    }
    const authoritative = materializeSessionConversationGraph({
      ...base,
      revision: 9,
      messages: [...base.messages, remoteMessage],
      updatedAt: base.updatedAt + 1
    })
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(8, 9))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 10 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().activateMessageBranch(base.id, editedBranchId)

    await expect(save(useSessionStore.getState())).resolves.toBeUndefined()

    const rebased = saveSession.mock.calls[1][0]
    expect(rebased.messages).toEqual([expect.objectContaining({ id: editedPrompt.id })])
    expect(rebased.conversationGraph?.messages.map(({ id }) => id)).toEqual([
      originalPrompt.id,
      editedPrompt.id,
      remoteMessage.id
    ])
    expect(() => materializeSessionConversationGraph(rebased)).not.toThrow()
  })

  it('merges disjoint streaming and artifact updates on the same Message identity', async () => {
    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'Create a chart',
      status: 'complete' as const,
      eventIds: [] as string[],
      createdAt: 1,
      updatedAt: 1
    }
    const partial = {
      id: 'agent-message-1',
      role: 'agent' as const,
      content: 'Partial',
      status: 'streaming' as const,
      streamId: 'run-1',
      responseToMessageId: prompt.id,
      eventIds: ['event-1'],
      createdAt: 2,
      updatedAt: 2
    }
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        messages: [prompt, partial]
      })
    )
    const authoritative = materializeSessionConversationGraph({
      ...base,
      revision: 9,
      messages: [prompt, { ...partial, artifactIds: ['artifact-version-1'], updatedAt: 3 }],
      artifacts: [
        {
          id: 'artifact-version-1',
          kind: 'managed-file',
          path: '/data/artifacts/chart.png',
          name: 'chart.png'
        }
      ],
      updatedAt: base.updatedAt + 1
    })
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(8, 9))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 10 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: base.id,
      streamId: partial.streamId,
      eventId: 'event-2',
      promptMessageId: prompt.id,
      content: ' response'
    })

    await expect(save(useSessionStore.getState())).resolves.toBeUndefined()

    expect(saveSession.mock.calls[1][0]).toMatchObject({
      artifacts: authoritative.artifacts,
      messages: [
        expect.objectContaining({ id: prompt.id }),
        expect.objectContaining({
          id: partial.id,
          content: 'Partial response',
          eventIds: ['event-1', 'event-2'],
          artifactIds: ['artifact-version-1']
        })
      ]
    })
  })

  it('does not merge competing edits that select different Branch identities', async () => {
    const target = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'Original prompt',
      status: 'complete' as const,
      eventIds: [] as string[],
      createdAt: 1,
      updatedAt: 1
    }
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        messages: [target]
      })
    )
    const authoritative = {
      ...base,
      revision: 9,
      messages: [],
      conversationGraph: forkEditedConversationMessage(
        base.conversationGraph,
        target.id,
        'remote-edit-branch',
        2
      ),
      updatedAt: base.updatedAt + 1
    }
    const conflict = new SessionRevisionConflictError(8, 9)
    const saveSession = vi.fn<SessionPersistenceApi['saveSession']>().mockRejectedValue(conflict)
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().removeMessage(base.id, target.id)

    await expect(save(useSessionStore.getState())).rejects.toBe(conflict)
    expect(saveSession).toHaveBeenCalledOnce()
  })

  it('rebases a Reviewer correction insertion over concurrent Main runtime authority', async () => {
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Make the claim.',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const authoritative = {
      ...base,
      revision: 9,
      runtimeContext: { version: 1 as const, revision: 1 },
      updatedAt: base.updatedAt + 1
    }
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(8, 9))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 10 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().appendRoutedUserMessage({
      sessionId: base.id,
      messageId: 'reviewer-correction-1',
      eventId: 'reviewer-correction-event-1',
      content: '[Auditor] Correct the unsupported claim.',
      createdAt: 2,
      attribution: {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-1'
      }
    })

    await expect(save(useSessionStore.getState())).resolves.toBeUndefined()

    expect(saveSession).toHaveBeenCalledTimes(2)
    expect(saveSession.mock.calls[1][0]).toMatchObject({
      revision: 9,
      runtimeContext: authoritative.runtimeContext,
      messages: [
        expect.objectContaining({ id: 'prompt-1' }),
        expect.objectContaining({
          id: 'reviewer-correction-1',
          attribution: {
            kind: 'application',
            feature: 'reviewer',
            purpose: 'correction',
            causeReviewId: 'review-1'
          }
        })
      ]
    })
  })

  it('does not retry when the same graph identity changed concurrently', async () => {
    const base = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 8,
        agentModel: 'base-model'
      })
    )
    const authoritative = {
      ...base,
      revision: 9,
      conversationGraph: {
        ...base.conversationGraph,
        runtimeSegments: base.conversationGraph.runtimeSegments.map((segment) => ({
          ...segment,
          model: 'remote-model'
        }))
      },
      updatedAt: base.updatedAt + 1
    }
    const conflict = new SessionRevisionConflictError(8, 9)
    const saveSession = vi.fn<SessionPersistenceApi['saveSession']>().mockRejectedValue(conflict)
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    const local = useSessionStore.getState().sessions[0]
    useSessionStore.setState({
      sessions: [
        {
          ...local,
          conversationGraph: {
            ...local.conversationGraph!,
            runtimeSegments: local.conversationGraph!.runtimeSegments.map((segment) => ({
              ...segment,
              model: 'local-model'
            }))
          },
          updatedAt: local.updatedAt + 1
        }
      ]
    })

    await expect(save(useSessionStore.getState())).rejects.toBe(conflict)
    expect(saveSession).toHaveBeenCalledOnce()
  })

  it('does not retry when both the local and authoritative conversation graphs changed', async () => {
    const base = materializeSessionConversationGraph(
      createPersistedSession({ projectId: 'project-a', revision: 1 })
    )
    const authoritative = materializeSessionConversationGraph({
      ...base,
      revision: 2,
      messages: [
        {
          id: 'remote-message',
          role: 'user',
          content: 'Changed in another window',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      updatedAt: base.updatedAt + 1
    })
    const conflict = new SessionRevisionConflictError(1, 2)
    const saveSession = vi.fn<SessionPersistenceApi['saveSession']>().mockRejectedValue(conflict)
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(authoritative),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().appendUserMessage({
      sessionId: base.id,
      content: 'Different local update',
      cwd: base.cwd,
      projectId: base.projectId
    })

    await expect(save(useSessionStore.getState())).rejects.toBe(conflict)
    expect(api.loadOne).toHaveBeenCalledOnce()
    expect(saveSession).toHaveBeenCalledOnce()
  })

  it('rebases from the exact externally published authority after a later revision conflict', async () => {
    const base = materializeSessionConversationGraph(
      createPersistedSession({ projectId: 'project-a', revision: 1 })
    )
    const published = materializeSessionConversationGraph({
      ...base,
      revision: 2,
      messages: [
        {
          id: 'published-message',
          role: 'agent',
          content: 'Published by Main',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      updatedAt: base.updatedAt + 1
    })
    const latest = materializeSessionConversationGraph({
      ...published,
      revision: 3,
      messages: [
        ...published.messages,
        {
          id: 'latest-message',
          role: 'agent',
          content: 'Newer authoritative graph',
          status: 'complete',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      updatedAt: published.updatedAt + 1
    })
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(2, 3))
      .mockImplementationOnce(async (submitted) => ({ ...submitted, revision: 4 }))
    const api = createApi({
      loadOne: vi.fn().mockResolvedValue(latest),
      saveSession
    })

    useSessionStore.getState().hydrateSessions([base])
    const save = createStoreSaver(api, useSessionStore.getState())
    useSessionStore.getState().upsertPersistedSession(published)
    await save(useSessionStore.getState())
    expect(toPersistedSession(useSessionStore.getState().sessions[0]).conversationGraph).toEqual(
      published.conversationGraph
    )
    useSessionStore.getState().renameSession(base.id, 'Local title')

    await expect(save(useSessionStore.getState())).resolves.toBeUndefined()

    expect(saveSession).toHaveBeenCalledTimes(2)
    expect(saveSession.mock.calls[0][0]).toMatchObject({ revision: 2, title: 'Local title' })
    expect(saveSession.mock.calls[1][0]).toMatchObject({ revision: 3, title: 'Local title' })
    expect(saveSession.mock.calls[1][0].messages).toEqual(latest.messages)
  })

  it('still saves an unsaved local title after a newer remote Session projection', async () => {
    const persisted = materializeSessionConversationGraph(
      createPersistedSession({
        projectId: 'project-a',
        revision: 1,
        title: 'Original'
      })
    )
    const remote = materializeSessionConversationGraph({
      ...persisted,
      revision: 2,
      title: 'Remote title',
      messages: [
        {
          id: 'remote-message',
          role: 'agent',
          content: 'Saved in another window',
          status: 'complete',
          eventIds: [],
          createdAt: persisted.updatedAt + 1,
          updatedAt: persisted.updatedAt + 1
        }
      ],
      updatedAt: persisted.updatedAt + 10
    })
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockImplementation(async (submitted) => ({
        ...submitted,
        revision: (submitted.revision ?? 0) + 1
      }))
    const api = createApi({ saveSession })
    useSessionStore.getState().hydrateSessions([persisted])
    const save = createStoreSaver(api, useSessionStore.getState())

    useSessionStore.getState().renameSession('session-1', 'Local draft')
    useSessionStore.getState().upsertPersistedSession(remote)
    await save(useSessionStore.getState())

    expect(useSessionStore.getState().sessions[0].title).toBe('Local draft')
    expect(useSessionStore.getState().sessions[0].unsavedTitle).toBeUndefined()
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Local draft', revision: 2 }),
      { conflictRebaseFields: ['title'] }
    )
  })

  it('reports an earlier failed write even when a later queued write succeeds', async () => {
    const api = createApi({
      saveSession: vi.fn().mockRejectedValue(new Error('disk full')),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    })
    const save = createStoreSaver(api)

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Persist me',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })

    await expect(save(useSessionStore.getState())).rejects.toThrow('disk full')
    expect(api.saveSession).toHaveBeenCalledOnce()
    expect(api.saveManifest).toHaveBeenCalledOnce()
  })

  it('keeps an explicit latest Session save after older store snapshots', async () => {
    const firstSave = createDeferred<void>()
    let durableTitle = ''
    const saveSession = vi.fn(async (submitted: PersistedChatSession) => {
      if (submitted.title === 'Queued first') await firstSave.promise
      durableTitle = submitted.title
      return submitted
    })
    const api = createApi({ saveSession })
    const persistence = createOrderedSessionPersistence(api)

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })
    const save = createStoreSaver(api, useSessionStore.getState(), {}, persistence)

    useSessionStore.getState().renameSession('session-1', 'Queued first')
    const queuedFirst = save(useSessionStore.getState())
    await flushMicrotasks()
    useSessionStore.getState().renameSession('session-1', 'Queued stale')
    const queuedStale = save(useSessionStore.getState())
    useSessionStore.getState().renameSession('session-1', 'Artifact latest')
    const latestSession = toPersistedSession(useSessionStore.getState().sessions[0])
    const explicitLatest = persistence.saveSession(latestSession)

    await flushMicrotasks()
    expect(saveSession).toHaveBeenCalledOnce()

    firstSave.resolve()
    await Promise.all([queuedFirst, queuedStale, explicitLatest])

    expect(saveSession).toHaveBeenCalledTimes(3)
    expect(durableTitle).toBe('Artifact latest')
  })

  it('stamps an explicit queued save with the last durable revision', async () => {
    const firstSave = createDeferred<PersistedChatSession>()
    const saveSession = vi.fn<SessionPersistenceApi['saveSession']>(async (submitted) => ({
      ...submitted,
      revision: 3
    }))
    const persistence = createOrderedSessionPersistence(createApi({ saveSession }))
    const session = createPersistedSession({ revision: 1 })

    const storeSave = persistence.saveLatestSession('session:session-1', () => firstSave.promise)
    const explicitSave = persistence.saveSession({ ...session, title: 'Explicit latest' })
    firstSave.resolve({ ...session, revision: 2 })
    await Promise.all([storeSave, explicitSave])

    expect(saveSession).toHaveBeenCalledOnce()
    expect(saveSession.mock.calls[0][0]).toMatchObject({
      revision: 2,
      title: 'Explicit latest'
    })
  })

  it('flushes only after explicit and coalesced queued writes settle', async () => {
    const firstSave = createDeferred<PersistedChatSession>()
    const latestSave = createDeferred<PersistedChatSession>()
    const api = createApi({
      saveSession: vi.fn(() => firstSave.promise)
    })
    const persistence = createOrderedSessionPersistence(api)
    const session = createPersistedSession()

    const saving = persistence.saveSession(session)
    const savingLatest = persistence.saveLatestSession('session-1', () => latestSave.promise)
    let flushed = false
    const flushing = persistence.flush().then(() => {
      flushed = true
    })
    await flushMicrotasks()

    expect(flushed).toBe(false)
    firstSave.resolve(session)
    await saving
    await flushMicrotasks()
    expect(flushed).toBe(false)

    latestSave.resolve(session)
    await savingLatest
    await flushing
    expect(flushed).toBe(true)
  })

  it('keeps an explicit save revision conflict unresolved until that Session saves successfully', async () => {
    const session = createPersistedSession({ revision: 1 })
    const conflict = new SessionRevisionConflictError(1, 2)
    const saveSession = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ...session, revision: 3 })
    vi.stubGlobal('window', {
      api: {
        sessions: {
          saveSession,
          saveManifest: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
    try {
      await expect(saveSessionInOrder(session)).rejects.toBe(conflict)
      await expect(flushSessionPersistence()).rejects.toMatchObject({
        code: 'session-revision-conflict'
      })

      await expect(saveSessionInOrder({ ...session, revision: 2 })).resolves.toMatchObject({
        revision: 3
      })
      await expect(flushSessionPersistence()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rebases an explicit Session save over a disjoint concurrent main-process update', async () => {
    const base = createPersistedSession({ revision: 8 })
    const submitted = createPersistedSession({
      revision: 8,
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: 'Artifact ready',
          status: 'complete',
          eventIds: [],
          artifactIds: ['artifact-1'],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })
    const latest = createPersistedSession({
      revision: 9,
      runtimeContext: {
        version: 1,
        revision: 1,
        permission: {
          state: 'pending',
          request: {
            requestId: 'permission-1',
            sessionId: base.id,
            toolCallId: 'tool-1',
            title: 'Run Notebook',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
          },
          originatingPromptMessageId: 'message-1',
          fingerprint: 'a'.repeat(64),
          createdAt: 3
        }
      }
    })
    const latestLoad = createDeferred<PersistedChatSession | undefined>()
    const saveSession = vi
      .fn<SessionPersistenceApi['saveSession']>()
      .mockRejectedValueOnce(new SessionRevisionConflictError(8, 9))
      .mockImplementationOnce(async (session) => ({ ...session, revision: 10 }))
      .mockImplementationOnce(async (session) => ({ ...session, revision: 11 }))
    const api = createApi({
      loadOne: vi.fn(() => latestLoad.promise),
      saveSession
    })
    const persistence = createOrderedSessionPersistence(api)

    useSessionStore.getState().hydrateSessions([base])
    createStoreSaver(api, useSessionStore.getState(), {}, persistence)

    const explicitSave = saveSessionInOrder(submitted, persistence, api)
    await flushMicrotasks()
    expect(api.loadOne).toHaveBeenCalledWith({
      projectId: base.projectId,
      sessionId: base.id
    })

    const laterSave = persistence.saveSession({ ...submitted, title: 'Later queued save' })
    await flushMicrotasks()
    expect(saveSession).toHaveBeenCalledOnce()

    latestLoad.resolve(latest)
    await expect(explicitSave).resolves.toMatchObject({
      revision: 10,
      messages: submitted.messages,
      runtimeContext: latest.runtimeContext
    })
    await expect(laterSave).resolves.toMatchObject({
      revision: 11,
      title: 'Later queued save'
    })
    expect(saveSession).toHaveBeenCalledTimes(3)
    expect(saveSession.mock.calls[1][0]).toMatchObject({
      revision: 9,
      messages: submitted.messages,
      runtimeContext: latest.runtimeContext
    })
    expect(saveSession.mock.calls[2][0]).toMatchObject({
      revision: 10,
      title: 'Later queued save'
    })
  })
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })

  return { promise, resolve }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
