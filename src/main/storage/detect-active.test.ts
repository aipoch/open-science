import { describe, expect, it } from 'vitest'

import type {
  DelegatedWorkAttemptRecord,
  DelegatedWorkAttemptStatus,
  PersistedChatSession
} from '../../shared/session-persistence'
import { createDelegatedActivityProjection, detectActiveSessions } from './detect-active'

const delegatedAttempt = (
  id: string,
  status: DelegatedWorkAttemptStatus
): DelegatedWorkAttemptRecord => ({
  id,
  status,
  resolvedAgent: { kind: 'main' },
  runtimeSegmentIds: [],
  startedAt: 1,
  ...(status === 'running' ? {} : { endedAt: 2 })
})

const delegatedSession = (
  records: NonNullable<
    NonNullable<PersistedChatSession['runtimeContext']>['delegatedWork']
  >['records']
): PersistedChatSession => ({
  id: 'delegated-session',
  projectId: 'p',
  title: 'Delegated session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  runtimeContext: { version: 1, revision: 1, delegatedWork: { records } },
  createdAt: 1,
  updatedAt: 2
})

describe('detectActiveSessions', () => {
  it('tags runtime prompts as agent and notebook sessions as notebook', () => {
    const result = detectActiveSessions({
      runtime: { getActivePromptSessions: () => [{ projectName: 'p', sessionId: 's1' }] },
      delegated: {
        getActiveDelegatedSessions: () => [{ projectName: 'p', sessionId: 'delegated-1' }]
      },
      notebook: { getActiveNotebookSessions: () => [{ projectId: 'p', sessionId: 's2' }] }
    })

    // The ACP runtime still uses its legacy key; the Notebook source is already canonical.
    expect(result).toEqual([
      { projectId: 'p', sessionId: 'delegated-1', kind: 'delegated' },
      { projectId: 'p', sessionId: 's1', kind: 'agent' },
      { projectId: 'p', sessionId: 's2', kind: 'notebook' }
    ])
  })

  it('returns an empty array when both sources are idle', () => {
    const result = detectActiveSessions({
      runtime: { getActivePromptSessions: () => [] },
      delegated: { getActiveDelegatedSessions: () => [] },
      notebook: { getActiveNotebookSessions: () => [] }
    })

    expect(result).toEqual([])
  })

  it('deduplicates root and delegated agent work for the same Session', () => {
    const source = { projectName: 'p', sessionId: 's1' }
    const result = detectActiveSessions({
      runtime: { getActivePromptSessions: () => [source] },
      delegated: { getActiveDelegatedSessions: () => [source] },
      notebook: { getActiveNotebookSessions: () => [{ projectId: 'p', sessionId: 's1' }] }
    })

    expect(result).toEqual([
      { projectId: 'p', sessionId: 's1', kind: 'delegated' },
      { projectId: 'p', sessionId: 's1', kind: 'notebook' }
    ])
  })

  it('projects root-idle delegated work into detection until its current Attempt is terminal', () => {
    const delegated = createDelegatedActivityProjection()
    const detect = (): ReturnType<typeof detectActiveSessions> =>
      detectActiveSessions({
        runtime: { getActivePromptSessions: () => [] },
        delegated,
        notebook: { getActiveNotebookSessions: () => [] }
      })

    delegated.recordSession(
      delegatedSession([
        { agentFrameId: 'done', attempts: [delegatedAttempt('a1', 'completed')] },
        { agentFrameId: 'inactive-live', attempts: [delegatedAttempt('a2', 'running')] }
      ])
    )
    expect(detect()).toEqual([
      { projectId: 'p', sessionId: 'delegated-session', kind: 'delegated' }
    ])

    delegated.recordSession(
      delegatedSession([
        { agentFrameId: 'done', attempts: [delegatedAttempt('a1', 'completed')] },
        {
          agentFrameId: 'inactive-live',
          attempts: [delegatedAttempt('a2', 'running'), delegatedAttempt('a3', 'cancelled')]
        }
      ])
    )
    expect(detect()).toEqual([])
  })
})
