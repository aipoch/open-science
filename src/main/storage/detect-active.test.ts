import { describe, expect, it } from 'vitest'

import { detectActiveSessions } from './detect-active'

describe('detectActiveSessions', () => {
  it('tags runtime prompts as agent and notebook sessions as notebook', () => {
    const result = detectActiveSessions({
      runtime: { getActivePromptSessions: () => [{ projectName: 'p', sessionId: 's1' }] },
      notebook: { getActiveNotebookSessions: () => [{ projectName: 'p', sessionId: 's2' }] }
    })

    // The runtime source calls the storage key projectName; detect-active exposes it as projectId.
    expect(result).toEqual([
      { projectId: 'p', sessionId: 's1', kind: 'agent' },
      { projectId: 'p', sessionId: 's2', kind: 'notebook' }
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
