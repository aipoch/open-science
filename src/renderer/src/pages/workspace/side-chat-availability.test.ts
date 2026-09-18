import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import { sideChatBlock } from './side-chat-availability'

const parent: ChatSession = {
  id: 'main',
  projectId: 'project',
  title: 'Main',
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    {
      id: 'user',
      role: 'user',
      content: 'Analyze',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
}

describe('independent Side chat admission', () => {
  it.each([
    'idle',
    'running',
    'error',
    'waiting-permission',
    'waiting-for-user',
    'waiting-plan-approval'
  ] as const)('main %s does not block any side chat action', (status) => {
    for (const action of ['open', 'transfer', 'send'] as const) {
      for (const pendingHistoryReplay of [
        undefined,
        { kind: 'all' },
        { kind: 'before-message', messageId: 'user' }
      ] as const) {
        expect(
          sideChatBlock({
            action,
            parent: { ...parent, status, pendingHistoryReplay },
            hydrated: true
          })
        ).toBeUndefined()
      }
    }
  })
  it.each([
    [undefined, 'parent-unavailable'],
    [{ ...parent, archivedAt: 2 }, 'parent-unavailable'],
    [{ ...parent, isPending: true }, 'parent-pending'],
    [{ ...parent, packageOrigin: {} }, 'parent-read-only'],
    [{ ...parent, messages: [] }, 'history-unavailable']
  ] as const)('protects parent ownership for all entry points (%j)', (session, reason) => {
    for (const action of ['open', 'transfer', 'send'] as const)
      expect(sideChatBlock({ action, parent: session as ChatSession | undefined })).toBe(reason)
  })
  it('never treats a different project as the same parent', () => {
    expect(sideChatBlock({ action: 'send', parent, projectId: 'other' })).toBe('parent-unavailable')
  })
  it('opens local drafts during recovery, uploads and another chat closing without allowing dispatch', () => {
    const facts = {
      parent,
      hydrated: false,
      hydrationError: 'offline',
      closing: true,
      hasAttachments: true
    }
    expect(sideChatBlock({ ...facts, action: 'open' })).toBeUndefined()
    expect(sideChatBlock({ ...facts, action: 'send' })).toBe('closing')
    expect(sideChatBlock({ ...facts, closing: false, action: 'send' })).toBe('restore-failed')
  })
  it.each(['conversationGraphSyncBlocked'] as const)(
    'requires a usable saved snapshot during %s',
    (flag) => {
      const session = { ...parent, [flag]: true }
      expect(sideChatBlock({ action: 'open', parent: session })).toBeUndefined()
      expect(sideChatBlock({ action: 'send', parent: session })).toBe('snapshot-pending')
    }
  )
  it('does not confuse a forbidden main branch switch with an unsaved snapshot', () => {
    expect(
      sideChatBlock({ action: 'send', parent: { ...parent, branchSwitchBlocked: true } })
    ).toBeUndefined()
  })
  it('blocks unsupported content only when sending', () => {
    expect(sideChatBlock({ action: 'send', parent, hasAttachments: true })).toBe('attachments')
    expect(sideChatBlock({ action: 'send', parent, hasContent: false })).toBe('empty')
    expect(sideChatBlock({ action: 'transfer', parent, running: true })).toBeUndefined()
  })
})
