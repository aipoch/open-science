import type { SessionDeletionHandlers } from '../session-persistence/coordinator'
import type { NotificationInboxController } from './notification-inbox-controller'

type NotificationInboxDeletionRuntimeDependencies = Readonly<{
  inbox: Pick<
    NotificationInboxController,
    'invalidateSessions' | 'markSessionsRead' | 'reconcileSessionCatalog'
  >
  sessionPersistenceCoordinator: {
    setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void
  }
  planSessionsReconciliation?: SessionDeletionHandlers['planReconciliation']
  onSessionsDeleted?: (sessionIds: readonly string[]) => Promise<void>
  onSessionsReconciled?: (existingSessionIds: readonly string[]) => Promise<void>
}>

// Session JSON remains authoritative for target existence. Archive acknowledges related messages
// while retaining bounded history; durable deletion invalidates them and blocks late terminal races.
export const bindNotificationInboxDeletionRuntime = (
  dependencies: NotificationInboxDeletionRuntimeDependencies
): void => {
  dependencies.sessionPersistenceCoordinator.setSessionDeletionHandlers({
    planReconciliation: dependencies.planSessionsReconciliation,
    commit: async (sessionIds) => {
      const results = await Promise.allSettled([
        dependencies.inbox.invalidateSessions(sessionIds),
        dependencies.onSessionsDeleted?.(sessionIds)
      ])
      // The coordinator must retain deleted identities until every cleanup has settled.
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
    },
    reconcile: async (existingSessionIds, archivedSessionIds) => {
      await Promise.all([
        dependencies.inbox.markSessionsRead(archivedSessionIds),
        dependencies.inbox.reconcileSessionCatalog(existingSessionIds),
        dependencies.onSessionsReconciled?.(existingSessionIds)
      ])
    }
  })
}
