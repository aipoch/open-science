import { describe, expect, it, vi } from 'vitest'

import type { SessionDeletionHandlers } from '../session-persistence/coordinator'
import { bindNotificationInboxDeletionRuntime } from './notification-inbox-runtime'

describe('notification inbox deletion runtime', () => {
  it('invalidates durable Side chats at the authoritative Session deletion boundary', async () => {
    let handlers: SessionDeletionHandlers | undefined
    const deleteSessions = vi.fn(async () => undefined)
    const onSessionsDeleted = vi.fn(async () => undefined)

    bindNotificationInboxDeletionRuntime({
      inbox: {
        deleteSessions,
        markSessionsRead: vi.fn(async () => undefined),
        reconcileSessionCatalog: vi.fn(async () => undefined)
      },
      sessionPersistenceCoordinator: {
        setSessionDeletionHandlers: (next) => {
          handlers = next
        }
      },
      onSessionsDeleted
    })

    await handlers?.commit(['session-1', 'session-2'])

    expect(deleteSessions).toHaveBeenCalledWith(['session-1', 'session-2'])
    expect(onSessionsDeleted).toHaveBeenCalledWith(['session-1', 'session-2'])
  })
})
