import { setImmediate } from 'node:timers/promises'
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

  it('waits for sibling cleanup when inbox invalidation fails', async () => {
    let handlers: SessionDeletionHandlers | undefined
    let releaseCleanup!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    bindNotificationInboxDeletionRuntime({
      inbox: {
        invalidateSessions: vi.fn().mockRejectedValue(new Error('inbox unavailable')),
        markSessionsRead: vi.fn(),
        reconcileSessionCatalog: vi.fn()
      },
      sessionPersistenceCoordinator: {
        setSessionDeletionHandlers: (next) => {
          handlers = next
        }
      },
      onSessionsDeleted: () => gate
    })
    let settled = false
    const cleanup = handlers!.commit(['session-1']).catch((error: unknown) => {
      settled = true
      return error
    })
    await setImmediate()
    try {
      expect(settled).toBe(false)
    } finally {
      releaseCleanup()
    }
    await expect(cleanup).resolves.toEqual(new Error('inbox unavailable'))
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
