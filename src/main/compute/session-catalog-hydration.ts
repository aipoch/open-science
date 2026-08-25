import type { LoadAllSessionsResult } from '../../shared/session-persistence'
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
}>

type SessionCatalogHydration = Readonly<{
  loadAll(): Promise<LoadAllSessionsResult>
  recoverProjectDeletions(): Promise<ProjectDeletionRecoveryForSessionRead>
}>

const createSessionCatalogHydration = (options: {
  owner(): SessionEnabledComputeHostsOwner
  projectRecovery: ProjectDeletionRecoveryBackend
  sessionLoader: SessionCatalogLoader
}): SessionCatalogHydration => {
  const hydrateCatalog: SessionCatalogHydrator = (loadCatalog) =>
    options.owner().hydrateFromSessionCatalog(loadCatalog)

  return {
    loadAll: () =>
      loadSessionsAfterProjectRecovery(
        options.projectRecovery,
        options.sessionLoader,
        undefined,
        hydrateCatalog
      ),
    recoverProjectDeletions: () =>
      recoverProjectDeletionsForSessionRead(
        options.projectRecovery,
        options.sessionLoader,
        undefined,
        hydrateCatalog
      )
  }
}

export { createSessionCatalogHydration }
export type { SessionCatalogHydration, SessionCatalogLoader }
