import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../../shared/session-persistence'
import { createSessionStore } from './session-store'

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'local-message',
      role: 'user',
      content: 'Keep local content',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  createdAt: 1,
  updatedAt: 10,
  revision: 3,
  archivedAt: 20
}

afterEach(() => vi.unstubAllGlobals())

describe('session archive authority ordering', () => {
  it('keeps archive state consistent when delegation policy advances the durable revision', () => {
    const store = createSessionStore()
    store.getState().hydrateSessions([session])
    store.getState().applyDelegationPolicyAuthority({
      ...session,
      revision: 4,
      archivedAt: undefined,
      delegationPolicy: 'deny'
    })
    expect(store.getState().sessions[0]).toMatchObject({ revision: 4, delegationPolicy: 'deny' })
    expect(store.getState().sessions[0].archivedAt).toBeUndefined()
  })

  it.each([
    'replace-persisted-if-current',
    'merge-upload-identities',
    'runtime-context-authority',
    'permission-authority',
    'session-details-authority',
    'compute-host-access-authority',
    'delegated-authority'
  ] as const)('keeps archive state consistent when %s advances the durable revision', (mode) => {
    const store = createSessionStore()
    store.getState().hydrateSessions([session])
    const source = store.getState().sessions[0]
    store.getState().applyDurableSessionProjection({
      source,
      session: { ...session, revision: 4, archivedAt: undefined },
      mode
    })
    expect(store.getState().sessions[0].revision).toBe(4)
    expect(store.getState().sessions[0].archivedAt).toBeUndefined()
  })

  it('keeps newer archive authority when a delayed durable replacement arrives', () => {
    const store = createSessionStore()
    store.getState().hydrateSessions([session])
    store.getState().applyDurableSessionProjection({
      source: store.getState().sessions[0],
      session: { ...session, revision: 2, archivedAt: undefined },
      mode: 'replace-persisted-if-current'
    })
    expect(store.getState().sessions[0]).toMatchObject({ revision: 3, archivedAt: 20 })
  })

  it.each([5, 100])('rejects an older revision with updatedAt=%s', (updatedAt) => {
    const store = createSessionStore()
    store.getState().hydrateSessions([session])
    store
      .getState()
      .upsertPersistedSession({ ...session, revision: 2, archivedAt: undefined, updatedAt })
    expect(store.getState().sessions[0]).toMatchObject({ revision: 3, archivedAt: 20 })
  })

  it('accepts a newer revision with older activity time and preserves unsaved content', () => {
    const store = createSessionStore()
    store.getState().hydrateSessions([session])
    store.getState().renameSession(session.id, 'Unsaved title')
    store.getState().upsertPersistedSession({
      ...session,
      messages: [],
      revision: 4,
      archivedAt: undefined,
      updatedAt: 5
    })
    expect(store.getState().sessions[0]).toMatchObject({
      revision: 4,
      title: 'Unsaved title',
      unsavedTitle: true
    })
    expect(store.getState().sessions[0].messages[0]?.content).toBe('Keep local content')
    expect(store.getState().sessions[0].archivedAt).toBeUndefined()
  })

  it.each([2, 4])('orders delayed content revision %s against summary revision 3', (revision) => {
    const store = createSessionStore()
    store.getState().hydrateSessionSummaries(
      [
        {
          ...session,
          number: 1,
          presentedStatus: 'idle',
          pinned: false,
          revision: 3,
          activeMessageCount: 0,
          artifactCount: 0,
          filesRevision: 0,
          needsStartupRecovery: false
        }
      ],
      undefined
    )
    store.getState().renameSession(session.id, 'Unsaved title')
    store.getState().upsertPersistedSession({ ...session, revision, archivedAt: undefined })
    expect(store.getState().sessions[0]).toMatchObject({
      revision: Math.max(3, revision),
      title: 'Unsaved title',
      archivedAt: revision > 3 ? undefined : 20
    })
    expect(store.getState().sessions[0].contentLoaded).not.toBe(false)
  })

  it('advances archive RPC revision without replacing local content or activity time', async () => {
    const store = createSessionStore()
    store.getState().hydrateSessions([session])
    store.getState().renameSession(session.id, 'Unsaved title')
    const updatedAt = store.getState().sessions[0].updatedAt
    vi.stubGlobal('window', {
      api: {
        sessions: {
          updateArchive: vi.fn().mockResolvedValue({
            ...session,
            revision: 4,
            archivedAt: undefined,
            messages: [],
            updatedAt: 5
          })
        }
      }
    })
    await store.getState().updateSessionArchive({
      projectId: session.projectId,
      sessionId: session.id,
      archived: false,
      expectedArchivedAt: 20
    })
    expect(store.getState().sessions[0]).toMatchObject({
      revision: 4,
      title: 'Unsaved title',
      updatedAt
    })
    expect(store.getState().sessions[0].messages[0]?.content).toBe('Keep local content')
    expect(store.getState().sessions[0].archivedAt).toBeUndefined()
  })
})

describe('session deletion fallback', () => {
  it.each(['mixed', 'unsorted', 'no candidate'] as const)(
    'selects a visible sibling: %s',
    (scenario) => {
      const store = createSessionStore()
      store.getState().hydrateSessions([session])
      const base = { ...store.getState().sessions[0], archivedAt: undefined }
      const active = [
        { ...base, id: 'older', updatedAt: 5 },
        { ...base, id: 'newest', updatedAt: 30 }
      ]
      const excluded = [
        { ...base, id: 'archived', archivedAt: 20, updatedAt: 100 },
        { ...base, id: 'draft', isPending: true, updatedAt: 200 },
        { ...base, id: 'other-project', projectId: 'project-2', updatedAt: 300 }
      ]
      store.setState({
        sessions: [
          base,
          ...(scenario === 'unsorted' ? [] : excluded),
          ...(scenario === 'no candidate' ? [] : active)
        ],
        selectedSessionId: base.id
      })
      store.getState().deleteSession(base.id)
      expect(store.getState().selectedSessionId).toBe(
        scenario === 'no candidate' ? undefined : 'newest'
      )
    }
  )
})
