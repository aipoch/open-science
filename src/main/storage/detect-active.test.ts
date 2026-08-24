import { describe, expect, it } from 'vitest'

import { detectActiveSessions } from './detect-active'

describe('detectActiveSessions', () => {
  it('tags runtime prompts as agent and notebook sessions as notebook', () => {
    const result = detectActiveSessions({
      runtime: { getActivePromptSessions: () => [{ projectId: 'p', sessionId: 's1' }] },
      delegated: {
        getActiveDelegatedSessions: () => [{ projectId: 'p', sessionId: 'delegated-1' }]
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
    const source = { projectId: 'p', sessionId: 's1' }
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
})
