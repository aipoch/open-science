import type { SessionDeletionHandlers } from '../session-persistence/coordinator'
import type { UnreadTaskController } from './unread-task-controller'
import type { UnreadTaskDbRepository } from './unread-task-repository'

type UnreadTaskDeletionRuntimeDeps = {
  headless: boolean
  unreadController: Pick<UnreadTaskController, 'removeUnreadSessions'>
  unreadTaskRepository: Pick<
    UnreadTaskDbRepository,
    'prepareDeletion' | 'commitDeletion' | 'abortDeletion' | 'reconcileSessionCatalog'
  >
  sessionPersistenceCoordinator: {
    setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void
  }
}

// Binds crash-safe unread cleanup before the first renderer can trigger a complete Session scan.
export const bindUnreadTaskDeletionRuntime = (deps: UnreadTaskDeletionRuntimeDeps): void => {
  // Headless web service has no local desktop user and must not read or mutate desktop unread state.
  if (deps.headless) return

  // Persist intent before Session JSON deletion, then clear both unread metadata and intent only
  // after the authoritative delete commits. A complete desktop scan also repairs interrupted or
  // headless deletions against the Session JSON catalog.
  deps.sessionPersistenceCoordinator.setSessionDeletionHandlers({
    prepare: (sessionIds) => deps.unreadTaskRepository.prepareDeletion(sessionIds),
    commit: async (sessionIds) => {
      await deps.unreadController.removeUnreadSessions(sessionIds)
      await deps.unreadTaskRepository.commitDeletion(sessionIds)
    },
    abort: (sessionIds) => deps.unreadTaskRepository.abortDeletion(sessionIds),
    reconcile: async (existingSessionIds) => {
      const deletedSessionIds =
        await deps.unreadTaskRepository.reconcileSessionCatalog(existingSessionIds)
      await deps.unreadController.removeUnreadSessions(deletedSessionIds)
    }
  })
}
