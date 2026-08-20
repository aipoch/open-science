import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  materializeSessionConversationGraph,
  SESSION_MANIFEST_VERSION,
  SessionRevisionConflictError,
  type LoadAllSessionsResult,
  type PersistedChatSession
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
})

describe('renderer session persistence bridge', () => {
  it('hydrates the store from the per-session load result', async () => {
    const api = createApi()

    await loadPersistedSessions(api)

    expect(api.loadAll).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ id: 'session-1' })
    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
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
