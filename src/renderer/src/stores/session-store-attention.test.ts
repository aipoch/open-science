import { describe, expect, it } from 'vitest'
import {
  activateConversationBranch,
  forkEditedConversationMessage,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages
} from '../../../shared/conversation-graph'
import {
  createSessionFile,
  decodeSessionFile,
  materializeSessionConversationGraph,
  setTurnOutcome,
  type PersistedChatSession,
  type SessionSummary
} from '../../../shared/session-persistence'
import {
  createSessionStore,
  hydrateSession,
  projectSessionActionability,
  toPersistedSession
} from './session-store'

const fixture = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 'session',
    projectId: 'project',
    title: 'Research',
    cwd: '/workspace',
    status: 'error',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Research',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome: { kind: 'failed', settledAt: 2, error: 'failed' }
      }
    ]
  })

describe('Session Attention renderer projection', () => {
  it.each(['missing-record', 'size-limit', 'conversation-graph-sync'] as const)(
    'shows %s without locking idle actions',
    (problem) => {
      const durable = setTurnOutcome({ ...fixture(), status: 'idle' }, 'prompt', {
        kind: 'completed',
        settledAt: 2
      })
      const session = hydrateSession({
        ...durable,
        recordProblems: problem === 'conversation-graph-sync' ? [] : [problem]
      })
      session.conversationGraphSyncBlocked = problem === 'conversation-graph-sync'
      const projection = projectSessionActionability(session)
      expect(projection).toMatchObject({
        presentedStatus: 'error',
        activity: 'inactive',
        attention: { recordProblems: [problem] }
      })
      expect(projection.actions.startTurn.allowed).toBe(true)
    }
  )

  it.each(['running', 'waiting-for-user', 'waiting-permission', 'waiting-plan-approval'] as const)(
    'prioritizes %s over a failed turn and record problems',
    (status) => {
      const projection = projectSessionActionability(
        hydrateSession({ ...fixture(), status, recordProblems: ['size-limit'] })
      )
      expect(projection.presentedStatus).toBe(status)
      expect(projection.attention?.turn?.promptMessageId).toBe('prompt')
    }
  )

  it('recomputes the selected Branch and a newer successful turn from current history', () => {
    const source = fixture()
    const originalBranch = source.conversationGraph!.branches[0].id
    const fork = forkEditedConversationMessage(source.conversationGraph!, 'prompt', 'edited', 3)
    const selected = synchronizeActiveConversationMessages(
      fork,
      [
        {
          ...source.messages[0],
          id: 'new-prompt',
          content: 'Edited',
          createdAt: 3,
          updatedAt: 3,
          turnOutcome: { kind: 'completed', settledAt: 4 }
        }
      ],
      4
    )
    const session = hydrateSession(source)
    session.conversationGraph = selected
    session.messages = resolveActiveConversationMessages(selected)
    expect(session.attention?.turn?.promptMessageId).toBe('prompt') // intentionally stale cached projection
    expect(projectSessionActionability(session)).toMatchObject({
      presentedStatus: 'idle',
      attention: undefined
    })
    session.conversationGraph = activateConversationBranch(selected, originalBranch)
    session.messages = resolveActiveConversationMessages(session.conversationGraph)
    expect(projectSessionActionability(session).attention?.turn?.promptMessageId).toBe('prompt')
  })

  it('retains Main summary attention when opening details and consumes exact fact clearing', () => {
    const durable = setTurnOutcome({ ...fixture(), status: 'idle' }, 'prompt', {
      kind: 'completed',
      settledAt: 2
    })
    const summary: SessionSummary = {
      id: durable.id,
      projectId: durable.projectId,
      number: 1,
      title: durable.title,
      status: 'idle',
      presentedStatus: 'error',
      recordProblems: ['size-limit'],
      pinned: false,
      revision: 0,
      activeMessageCount: 1,
      artifactCount: 0,
      filesRevision: 0,
      createdAt: 1,
      updatedAt: 2,
      needsStartupRecovery: false
    }
    const store = createSessionStore()
    store.getState().hydrateSessionSummaries([summary], undefined)
    expect(projectSessionActionability(store.getState().sessions[0]).attention).toBeDefined()
    store.getState().upsertPersistedSession({ ...durable, recordProblems: ['size-limit'] })
    expect(
      projectSessionActionability(store.getState().sessions[0]).attention?.recordProblems
    ).toEqual(['size-limit'])
    const source = store.getState().sessions[0]
    store.getState().applyDurableSessionProjection({
      source,
      session: { ...durable, recordProblems: [] },
      mode: 'runtime-transcript-authority'
    })
    expect(projectSessionActionability(store.getState().sessions[0]).attention).toBeUndefined()
  })

  it('keeps window-local graph blocking through a receipt but strips all attention facts on save', () => {
    const store = createSessionStore()
    store.getState().upsertPersistedSession({ ...fixture(), recordProblems: ['missing-record'] })
    store.setState({
      sessions: store
        .getState()
        .sessions.map((session) => ({ ...session, conversationGraphSyncBlocked: true }))
    })
    const source = store.getState().sessions[0]
    const completed = setTurnOutcome(
      { ...fixture(), status: 'idle', revision: 1, recordProblems: [] },
      'prompt',
      { kind: 'completed', settledAt: 3 }
    )
    store.getState().applyDurableSessionProjection({
      source,
      session: completed,
      mode: 'runtime-transcript-authority'
    })
    const session = store.getState().sessions[0]
    expect(projectSessionActionability(session).attention?.recordProblems).toEqual([
      'conversation-graph-sync'
    ])
    expect(() => toPersistedSession(session)).toThrow('conversation graph synchronization')
    const saved = toPersistedSession({ ...session, conversationGraphSyncBlocked: false })
    expect(saved).not.toHaveProperty('recordProblems')
    expect(saved).not.toHaveProperty('attention')
    const encoded = createSessionFile({ ...saved, recordProblems: ['size-limit'] })
    expect(encoded.session).not.toHaveProperty('recordProblems')
    const decoded = decodeSessionFile(encoded, { preserveRuntimeState: true })
    expect(decoded.status).toBe('ok')
  })
})
