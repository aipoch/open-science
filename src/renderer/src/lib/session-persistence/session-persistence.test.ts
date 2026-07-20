import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SESSION_MANIFEST_VERSION,
  type LoadAllSessionsResult,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import {
  createStoreSaver,
  loadPersistedSessions,
  reconcilePendingArtifacts,
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
  saveSession: vi.fn().mockResolvedValue(undefined),
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
      projectName: 'proj-1',
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
      projectName: 'proj-1',
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
    const firstSave = createDeferred<void>()
    const secondSave = createDeferred<void>()
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

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Third',
      cwd: '/workspace/project'
    })
    void save(useSessionStore.getState())

    await flushMicrotasks()
    expect(saveSession).toHaveBeenCalledTimes(1)

    firstSave.resolve()
    await flushMicrotasks()
    expect(saveSession).toHaveBeenCalledTimes(2)

    secondSave.resolve()
    await flushMicrotasks()
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
}
