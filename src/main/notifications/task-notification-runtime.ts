import type { SessionDeletionHandlers } from '../session-persistence/coordinator'
import type { UnreadTaskController } from './unread-task-controller'
import type { UnreadTaskDbRepository } from './unread-task-repository'

type UnreadTaskDeletionRuntimeDeps = {
  headless: boolean
  unreadController: Pick<UnreadTaskController, 'markReadSessions' | 'removeUnreadSessions'>
  unreadTaskRepository: Pick<UnreadTaskDbRepository, 'reconcileSessionCatalog'>
  sessionPersistenceCoordinator: {
    setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void
  }
}

// Binds crash-safe unread reconciliation before the first renderer can trigger a complete Session
// scan.
export const bindUnreadTaskDeletionRuntime = (deps: UnreadTaskDeletionRuntimeDeps): void => {
  // Headless web service has no local desktop user and must not read or mutate desktop unread state.
  if (deps.headless) return

  // Clear live unread state only after authoritative Session deletion commits. A complete desktop
  // scan also repairs interrupted archive or headless cleanup against the Session JSON catalog.
  deps.sessionPersistenceCoordinator.setSessionDeletionHandlers({
    commit: (sessionIds) => deps.unreadController.removeUnreadSessions(sessionIds),
    reconcile: async (existingSessionIds, archivedSessionIds) => {
      const archived = new Set(archivedSessionIds)
      const attentionEligibleSessionIds = existingSessionIds.filter(
        (sessionId) => !archived.has(sessionId)
      )

      // Archive is an acknowledgement, not a deletion: clear live state without creating the
      // process-lifetime tombstones that protect terminal Session deletion races.
      await deps.unreadController.markReadSessions(archivedSessionIds)
      const removedSessionIds = await deps.unreadTaskRepository.reconcileSessionCatalog(
        attentionEligibleSessionIds
      )
      const deletedSessionIds = removedSessionIds.filter((sessionId) => !archived.has(sessionId))
      await deps.unreadController.removeUnreadSessions(deletedSessionIds)
    }
  })
}
