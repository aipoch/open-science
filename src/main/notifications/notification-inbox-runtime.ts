import type { SessionDeletionHandlers } from '../session-persistence/coordinator'
import type { NotificationInboxController } from './notification-inbox-controller'

type NotificationInboxDeletionRuntimeDependencies = Readonly<{
  inbox: Pick<
    NotificationInboxController,
    'deleteSessions' | 'markSessionsRead' | 'reconcileSessionCatalog'
  >
  sessionPersistenceCoordinator: {
    setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void
  }
}>

// Session JSON remains authoritative for target existence. Archive acknowledges related messages
// while retaining bounded history; durable deletion removes them and blocks late terminal races.
export const bindNotificationInboxDeletionRuntime = (
  dependencies: NotificationInboxDeletionRuntimeDependencies
): void => {
  dependencies.sessionPersistenceCoordinator.setSessionDeletionHandlers({
    commit: (sessionIds) => dependencies.inbox.deleteSessions(sessionIds),
    reconcile: async (existingSessionIds, archivedSessionIds) => {
      await dependencies.inbox.markSessionsRead(archivedSessionIds)
      await dependencies.inbox.reconcileSessionCatalog(existingSessionIds)
    }
  })
}
