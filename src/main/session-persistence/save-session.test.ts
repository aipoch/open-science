import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { saveSessionWithRevision } from './save-session'

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  revision: 4,
  createdAt: 1,
  updatedAt: 2
}

describe('saveSessionWithRevision', () => {
  it('requires the repository to return the saved Session', () => {
    type Repository = Parameters<typeof saveSessionWithRevision>[0]
    expectTypeOf<
      Awaited<ReturnType<Repository['saveSession']>>
    >().toEqualTypeOf<PersistedChatSession>()
  })

  it.each([undefined, 4])(
    'preserves the repository receipt with expected revision %s',
    async (expectedRevision) => {
      const receipt = { ...session, revision: 9, number: 42 }
      const saveSession = vi.fn(async () => receipt)

      await expect(
        saveSessionWithRevision({ saveSession }, session, expectedRevision)
      ).resolves.toBe(receipt)
      expect(saveSession.mock.calls).toEqual([
        expectedRevision === undefined ? [session] : [session, expectedRevision]
      ])
    }
  )

  it.each([undefined, 4])(
    'propagates a failed save with expected revision %s',
    async (expectedRevision) => {
      const error = new Error('Session publication failed')
      const saveSession = vi.fn(async (): Promise<PersistedChatSession> => {
        throw error
      })

      await expect(
        saveSessionWithRevision({ saveSession }, session, expectedRevision)
      ).rejects.toBe(error)
    }
  )
})
