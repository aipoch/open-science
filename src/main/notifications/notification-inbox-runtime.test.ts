import { describe, expect, it, vi } from 'vitest'

import type { SessionDeletionHandlers } from '../session-persistence/coordinator'
import { bindNotificationInboxDeletionRuntime } from './notification-inbox-runtime'

describe('notification inbox deletion runtime', () => {
  it('invalidates durable Side chats at the authoritative Session deletion boundary', async () => {
    let handlers: SessionDeletionHandlers | undefined
    const invalidateSessions = vi.fn(async () => undefined)
    const onSessionsDeleted = vi.fn(async () => undefined)

    bindNotificationInboxDeletionRuntime({
      inbox: {
        invalidateSessions,
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

    expect(invalidateSessions).toHaveBeenCalledWith(['session-1', 'session-2'])
    expect(onSessionsDeleted).toHaveBeenCalledWith(['session-1', 'session-2'])
  })

  it('reconciles derived evidence only from a complete authoritative Session catalog', async () => {
    let handlers: SessionDeletionHandlers | undefined
    const onSessionsReconciled = vi.fn(async () => undefined)
    bindNotificationInboxDeletionRuntime({
      inbox: {
        invalidateSessions: vi.fn(async () => undefined),
        markSessionsRead: vi.fn(async () => undefined),
        reconcileSessionCatalog: vi.fn(async () => undefined)
      },
      sessionPersistenceCoordinator: {
        setSessionDeletionHandlers: (next) => {
          handlers = next
        }
      },
      onSessionsReconciled
    })

    await handlers?.reconcile(['session-1'], [])

    expect(onSessionsReconciled).toHaveBeenCalledWith(['session-1'])
  })
})
