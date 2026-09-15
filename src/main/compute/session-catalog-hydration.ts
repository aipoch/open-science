import type { LoadAllSessionsResult, PersistedChatSession } from '../../shared/session-persistence'
import { canReconcileSessionAbsences } from '../session-persistence/catalog-authority'
import {
  loadSessionsAfterProjectRecovery,
  recoverProjectDeletionsForSessionRead,
  type ProjectDeletionRecoveryBackend,
  type ProjectDeletionRecoveryForSessionRead,
  type SessionCatalogHydrator
} from '../session-persistence/ipc'
import type { SessionEnabledComputeHostsOwner } from './session-enabled-hosts-owner'

type SessionCatalogLoader = Readonly<{
  loadAll(): Promise<LoadAllSessionsResult>
  loadAllReadOnly(): Promise<LoadAllSessionsResult>
  inspectSessionDetailsStartupSessions(): Promise<readonly PersistedChatSession[]>
}>

type SessionCatalogHydration = Readonly<{
  loadAll(): Promise<LoadAllSessionsResult>
  recoverProjectDeletions(): Promise<ProjectDeletionRecoveryForSessionRead>
  listSessionDetailsStartupSessions(): Promise<readonly PersistedChatSession[]>
}>

const createSessionCatalogHydration = (options: {
  owner(): SessionEnabledComputeHostsOwner
  projectRecovery: ProjectDeletionRecoveryBackend
  sessionLoader: SessionCatalogLoader
}): SessionCatalogHydration => {
  const hydrateCatalog: SessionCatalogHydrator = (loadCatalog) =>
    options.owner().hydrateFromSessionCatalog(loadCatalog)
  let primaryHydrationComplete = false

  const loadAll = async (): Promise<LoadAllSessionsResult> => {
    const result = await loadSessionsAfterProjectRecovery(
      options.projectRecovery,
      options.sessionLoader,
      undefined,
      hydrateCatalog
    )
    primaryHydrationComplete = canReconcileSessionAbsences(result)
    return result
  }

  return {
    loadAll,
    recoverProjectDeletions: () =>
      recoverProjectDeletionsForSessionRead(
        options.projectRecovery,
        options.sessionLoader,
        undefined,
        hydrateCatalog
      ),
    listSessionDetailsStartupSessions: async () => {
      // If the earlier Compute-owned hydration failed or returned a partial catalog, retry the full
      // boundary so Session details cannot accidentally become the only successful startup reader.
      if (!primaryHydrationComplete) return (await loadAll()).sessions
      const recovery = await recoverProjectDeletionsForSessionRead(
        options.projectRecovery,
        options.sessionLoader,
        undefined,
        hydrateCatalog
      )
      if (!recovery.isComplete) return recovery.result.sessions
      return options.sessionLoader.inspectSessionDetailsStartupSessions()
    }
  }
}

export { createSessionCatalogHydration }
export type { SessionCatalogHydration, SessionCatalogLoader }
