import { describe, expect, it } from 'vitest'

import { detectActiveSessions } from './detect-active'

describe('detectActiveSessions', () => {
  it('tags runtime prompts as agent and notebook sessions as notebook', () => {
    const result = detectActiveSessions({
      runtime: { getActivePromptSessions: () => [{ projectName: 'p', sessionId: 's1' }] },
      notebook: { getActiveNotebookSessions: () => [{ projectName: 'p', sessionId: 's2' }] }
    })

    expect(result).toEqual([
      { projectName: 'p', sessionId: 's1', kind: 'agent' },
      { projectName: 'p', sessionId: 's2', kind: 'notebook' }
    ])
  })

  it('returns an empty array when both sources are idle', () => {
    const result = detectActiveSessions({
      runtime: { getActivePromptSessions: () => [] },
      notebook: { getActiveNotebookSessions: () => [] }
    })

    expect(result).toEqual([])
  })
})
