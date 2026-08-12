import { describe, expect, it } from 'vitest'

import type {
  DelegatedWorkAttemptRecord,
  DelegatedWorkAttemptStatus,
  DelegatedWorkRecord,
  PersistedChatSession
} from './session-persistence'
import {
  earliestCurrentDelegatedAttemptStartedAt,
  hasCurrentRunningDelegatedAttempt
} from './delegated-work-projection'

const attempt = (id: string, status: DelegatedWorkAttemptStatus): DelegatedWorkAttemptRecord => ({
  id,
  status,
  resolvedAgent: { kind: 'main' },
  runtimeSegmentIds: [],
  startedAt: 1,
  ...(status === 'running' ? {} : { endedAt: 2 })
})

const sessionWith = (
  records: readonly DelegatedWorkRecord[]
): Pick<PersistedChatSession, 'runtimeContext'> => ({
  runtimeContext: { version: 1 as const, revision: 1, delegatedWork: { records } }
})

describe('hasCurrentRunningDelegatedAttempt', () => {
  it('finds child work while the root Session itself is idle and without consulting branch state', () => {
    expect(
      hasCurrentRunningDelegatedAttempt(
        sessionWith([
          { agentFrameId: 'inactive-branch-child', attempts: [attempt('a1', 'running')] }
        ])
      )
    ).toBe(true)
  })

  it.each(['completed', 'cancelled', 'error'] as const)('ignores a terminal %s child', (status) => {
    expect(
      hasCurrentRunningDelegatedAttempt(
        sessionWith([{ agentFrameId: 'child', attempts: [attempt('a1', status)] }])
      )
    ).toBe(false)
  })

  it('finds a running child among mixed terminal children', () => {
    expect(
      hasCurrentRunningDelegatedAttempt(
        sessionWith([
          { agentFrameId: 'done', attempts: [attempt('a1', 'completed')] },
          { agentFrameId: 'live', attempts: [attempt('a2', 'running')] },
          { agentFrameId: 'failed', attempts: [attempt('a3', 'error')] }
        ])
      )
    ).toBe(true)
  })

  it('uses only the latest continuation Attempt in each child record', () => {
    expect(
      hasCurrentRunningDelegatedAttempt(
        sessionWith([
          {
            agentFrameId: 'continued-child',
            attempts: [attempt('a1', 'completed'), attempt('a2', 'running')]
          }
        ])
      )
    ).toBe(true)
    expect(
      hasCurrentRunningDelegatedAttempt(
        sessionWith([
          {
            agentFrameId: 'continued-child',
            attempts: [attempt('a1', 'running'), attempt('a2', 'completed')]
          }
        ])
      )
    ).toBe(false)
  })

  it('timestamps all branches from the earliest latest/current running Attempt', () => {
    const older = { ...attempt('a1', 'completed'), startedAt: 10 }
    const current = { ...attempt('a2', 'running'), startedAt: 40 }
    expect(
      earliestCurrentDelegatedAttemptStartedAt(
        sessionWith([
          { agentFrameId: 'inactive-branch', attempts: [older, current] },
          {
            agentFrameId: 'active-branch',
            attempts: [{ ...attempt('a3', 'running'), startedAt: 70 }]
          },
          { agentFrameId: 'terminal', attempts: [{ ...attempt('a4', 'completed'), startedAt: 5 }] }
        ])
      )
    ).toBe(40)
  })
})
