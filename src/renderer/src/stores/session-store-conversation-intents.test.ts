import { beforeEach, describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../../shared/conversation-graph'
import type {
  PersistedChatMessage,
  PersistedChatSession
} from '../../../shared/session-persistence'
import {
  pendingSessionConversationCommands,
  resetSessionConversationIntentsForTests
} from './session-conversation-intents'
import { createSessionStore } from './session-store'

const persistedSession = (): PersistedChatSession => {
  const message: PersistedChatMessage = {
    id: 'prompt-1',
    role: 'user',
    content: 'First',
    status: 'complete',
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  }
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    status: 'idle',
    permissionProfile: 'ask',
    messages: [message],
    conversationGraph: createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message],
      createdAt: 1,
      updatedAt: 1
    }),
    runtimeTranscriptOwner: 'main',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('Session store conversation intent capture', () => {
  beforeEach(resetSessionConversationIntentsForTests)

  it.each([false, true])(
    'persists interrupted continuation admission, reset=%s',
    (contextReset) => {
      const store = createSessionStore()
      const interrupted = persistedSession()
      interrupted.status = 'error'
      interrupted.resumeRecovery = {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: 'prompt-1'
      }
      store.getState().hydrateSessions([interrupted])
      const prepared = store
        .getState()
        .prepareInterruptedTurnContinuation('session-1', 'prompt-1', undefined, contextReset)
      expect(prepared).toBeDefined()
      expect(store.getState().sessions[0].activeRun?.promptMessageId).toBe('prompt-1')
      expect(pendingSessionConversationCommands('session-1').map(({ kind }) => kind)).toEqual(
        contextReset ? ['open-segment', 'resume-run'] : ['resume-run']
      )
    }
  )

  it('captures an explicit append and run without treating runtime output as user intent', () => {
    const store = createSessionStore()
    store.getState().hydrateSessions([persistedSession()])
    const appended = store.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Second'
    })
    store.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'stream-1',
      eventId: 'runtime-event-1',
      promptMessageId: appended?.messageId,
      content: 'Answer'
    })

    expect(pendingSessionConversationCommands('session-1').map(({ kind }) => kind)).toEqual([
      'append-user',
      'start-run'
    ])
  })

  it('rejects a stale Main transcript receipt after a newer durable projection', () => {
    const store = createSessionStore()
    const current = persistedSession()
    current.revision = 5
    current.title = 'Current title'
    store.getState().hydrateSessions([current])

    const source = store.getState().sessions[0]
    store.getState().applyDurableSessionProjection({
      source,
      session: { ...current, revision: 4, title: 'Stale title', messages: [] },
      mode: 'runtime-transcript-authority'
    })

    expect(store.getState().sessions[0]).toMatchObject({
      revision: 5,
      title: 'Current title',
      messages: [{ id: 'prompt-1' }]
    })
  })
})
