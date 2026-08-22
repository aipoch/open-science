import { describe, expect, it } from 'vitest'

import { rebaseSafeSessionFields } from './revision-conflict'
import type { PersistedChatSession } from '../../shared/session-persistence'

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('rebaseSafeSessionFields', () => {
  it('replays a renderer Session agent configuration onto a newer durable snapshot', () => {
    const configuration = {
      providerId: 'provider-session',
      model: 'model-session',
      reasoningEffort: 'high' as const
    }
    const rebased = rebaseSafeSessionFields(
      session({
        title: 'Main title',
        agentConfiguration: {
          providerId: 'provider-old',
          model: 'model-old',
          reasoningEffort: 'low'
        },
        updatedAt: 4
      }),
      session({
        title: 'Renderer title',
        agentConfiguration: configuration,
        updatedAt: 3
      }),
      ['agentConfiguration']
    )

    expect(rebased).toMatchObject({
      title: 'Main title',
      agentConfiguration: configuration,
      updatedAt: 5
    })
  })
})
