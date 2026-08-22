import { describe, expect, it } from 'vitest'

import { CODEX_ISOLATED_PROVIDER_ID, CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/settings'
import {
  materializeSessionAgentConfiguration,
  toAcpSessionAgentTarget
} from './session-agent-target'

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

  it('normalizes legacy Codex provider aliases when materializing a Session target', () => {
    expect(
      materializeSessionAgentConfiguration(
        { agentBackendId: `codex:${CODEX_ISOLATED_PROVIDER_ID}`, agentModel: 'gpt-5.4' },
        'high'
      )
    ).toEqual({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'gpt-5.4',
      reasoningEffort: 'high'
    })
  })
})
