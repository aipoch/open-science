import { describe, expect, it } from 'vitest'
import {
  renameSessionRequestSchema,
  sessionMetadataReceipt,
  sessionMetadataReceiptSchema,
  setSessionPinnedRequestSchema
} from './commands'
import type { PersistedChatSession } from './session'

describe('narrow Session metadata contracts', () => {
  it('rejects a transcript or partial field baseline smuggled into a metadata command', () => {
    const rename = { projectId: 'p', sessionId: 's', title: 'New', expectedTitle: 'Old' }
    const pin = { projectId: 'p', sessionId: 's', pinned: true, expectedPinned: false }
    expect(renameSessionRequestSchema.safeParse({ ...rename, messages: [] }).success).toBe(false)
    expect(setSessionPinnedRequestSchema.safeParse({ ...pin, messages: [] }).success).toBe(false)
    expect(
      renameSessionRequestSchema.safeParse({ ...rename, expectedTitle: undefined }).success
    ).toBe(false)
    expect(
      setSessionPinnedRequestSchema.safeParse({ ...pin, expectedPinned: undefined }).success
    ).toBe(false)
  })

  it('bounds a successful receipt independently of the stored transcript size', () => {
    const session: PersistedChatSession = {
      id: 's',
      projectId: 'p',
      title: 'Title',
      status: 'idle',
      cwd: '/workspace',
      createdAt: 1,
      updatedAt: 2,
      revision: 8,
      messages: [
        {
          id: 'm',
          role: 'user',
          content: 'x'.repeat(1_000_000),
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
    const receipt = sessionMetadataReceipt(session)
    expect(JSON.stringify(receipt).length).toBeLessThan(256)
    expect(receipt).not.toHaveProperty('messages')
    expect(
      sessionMetadataReceiptSchema.safeParse({ ...receipt, messages: session.messages }).success
    ).toBe(false)
  })
})
