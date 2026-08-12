import { describe, expect, it } from 'vitest'

import { hasDelegatedActiveSession, type ActiveSessionInfo } from './storage'

describe('hasDelegatedActiveSession', () => {
  it('returns false without a delegated hard blocker', () => {
    const sessions: ActiveSessionInfo[] = [
      { projectId: 'p', sessionId: 'root', kind: 'agent' },
      { projectId: 'p', sessionId: 'notebook', kind: 'notebook' }
    ]

    expect(hasDelegatedActiveSession(sessions)).toBe(false)
  })

  it('returns true when any active Session is delegated work', () => {
    const sessions: ActiveSessionInfo[] = [
      { projectId: 'p', sessionId: 'root', kind: 'agent' },
      { projectId: 'p', sessionId: 'child', kind: 'delegated' }
    ]

    expect(hasDelegatedActiveSession(sessions)).toBe(true)
  })
})
