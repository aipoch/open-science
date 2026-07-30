import type { SessionDeletionHandlers } from '../session-persistence/coordinator'
import type { UnreadTaskController } from './unread-task-controller'
import type { UnreadTaskDbRepository } from './unread-task-repository'

type UnreadTaskDeletionRuntimeDeps = {
  headless: boolean
  unreadController: Pick<UnreadTaskController, 'removeUnreadSessions'>
  unreadTaskRepository: Pick<UnreadTaskDbRepository, 'reconcileSessionCatalog'>
  sessionPersistenceCoordinator: {
    setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void
  }
}

// Binds crash-safe unread cleanup before the first renderer can trigger a complete Session scan.
export const bindUnreadTaskDeletionRuntime = (deps: UnreadTaskDeletionRuntimeDeps): void => {
  // Headless web service has no local desktop user and must not read or mutate desktop unread state.
  if (deps.headless) return

  // Clear live unread state only after authoritative Session deletion commits. A complete desktop
  // scan repairs interrupted or headless cleanup against the Session JSON catalog.
  deps.sessionPersistenceCoordinator.setSessionDeletionHandlers({
    commit: (sessionIds) => deps.unreadController.removeUnreadSessions(sessionIds),
    reconcile: async (existingSessionIds) => {
      const deletedSessionIds =
        await deps.unreadTaskRepository.reconcileSessionCatalog(existingSessionIds)
      await deps.unreadController.removeUnreadSessions(deletedSessionIds)
    }
  })
}
