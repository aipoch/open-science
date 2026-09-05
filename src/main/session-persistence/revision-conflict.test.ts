import { describe, expect, it } from 'vitest'

import { rebaseSafeSessionFields, resolveRevisionedSessionSave } from './revision-conflict'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'

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
  it.each([
    [undefined, true],
    [true, undefined]
  ])(
    'preserves a pending reset across a preference conflict (authority=%s, submitted=%s)',
    (authoritativeReset, submittedReset) => {
      const base = materializeSessionConversationGraph(session({ revision: 1 }))
      const authoritative = {
        ...base,
        revision: 2,
        memoryEnabled: true,
        branchContextResetRequired: authoritativeReset
      }
      const submitted = {
        ...base,
        memoryEnabled: false,
        branchContextResetRequired: submittedReset
      }

      const rebased = resolveRevisionedSessionSave(authoritative, submitted, ['memoryEnabled'])

      expect(rebased.expectedRevision).toBe(2)
      expect(rebased.session.memoryEnabled).toBe(false)
      expect(rebased.session.branchContextResetRequired).toBe(true)
    }
  )

  it('allows a current save to acknowledge that the pending reset completed', () => {
    const authoritative = session({ revision: 2, branchContextResetRequired: true })
    const submitted = { ...authoritative, branchContextResetRequired: undefined }

    expect(
      resolveRevisionedSessionSave(authoritative, submitted).session.branchContextResetRequired
    ).toBeUndefined()
  })

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
