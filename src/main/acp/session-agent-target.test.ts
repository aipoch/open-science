import { describe, expect, it } from 'vitest'

import { toAcpSessionAgentTarget } from './session-agent-target'

describe('Session agent target', () => {
  it('combines the active framework with a durable Session configuration', () => {
    expect(
      toAcpSessionAgentTarget('opencode', {
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'high'
      })
    ).toEqual({
      frameworkId: 'opencode',
      providerId: 'provider-1',
      model: 'model-1',
      reasoningEffort: 'high'
    })
    expect(toAcpSessionAgentTarget('codex')).toBeUndefined()
  })
})
