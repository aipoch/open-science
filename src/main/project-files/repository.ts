import type { PersistedChatSession } from '../../shared/session-persistence'
import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  HostArtifactCatalogItem,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview,
  ProjectFilesPage,
  ProjectFileSource,
  ResolveProjectFileRequest,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'
import {
  ProjectFilesMutationOwner,
  type ManagedFileSoftDeleteToken,
  type ManagedFileSyncOptions
} from './mutation-owner'
import type {
  ProjectFilesClient,
  ProjectFilesClientFactory,
  ProjectFilesClientProvider,
  LegacyArtifactVersionAdopter,
  LegacyUploadVersionUpgrader
} from './mutation-projection'
import { ProjectFilesQueryOwner } from './query-owner'

// Stable public facade for the query-optimized Project Files projection. Session JSON remains
// authoritative; internal owners separate read orchestration from mutation/completeness state.
class ManagedFileIndexRepository {
  private readonly mutationOwner: ProjectFilesMutationOwner
  private readonly queryOwner: ProjectFilesQueryOwner

  constructor(
    getClient: ProjectFilesClientProvider,
    dataRoot: string,
    legacyArtifactVersionAdopter: LegacyArtifactVersionAdopter,
    legacyUploadVersionUpgrader: LegacyUploadVersionUpgrader
  ) {
    this.mutationOwner = new ProjectFilesMutationOwner(
      getClient,
      dataRoot,
      legacyArtifactVersionAdopter,
      legacyUploadVersionUpgrader
    )
    this.queryOwner = new ProjectFilesQueryOwner(getClient, (projectId) =>
      this.mutationOwner.isIndexComplete(projectId)
    )
  }

  syncSession(
    session: PersistedChatSession,
    options: ManagedFileSyncOptions = {}
  ): Promise<ProjectFileSource[]> {
    return this.mutationOwner.syncSession(session, options)
  }

  softDeleteSession(projectId: string, sessionId: string): Promise<ManagedFileSoftDeleteToken> {
    return this.mutationOwner.softDeleteSession(projectId, sessionId)
  }

  restoreSession(
    projectId: string,
    sessionId: string,
    token: ManagedFileSoftDeleteToken
  ): Promise<void> {
    return this.mutationOwner.restoreSession(projectId, sessionId, token)
  }

  softDeleteProject(projectId: string): Promise<ManagedFileSoftDeleteToken> {
    return this.mutationOwner.softDeleteProject(projectId)
  }

  restoreProject(projectId: string, token: ManagedFileSoftDeleteToken): Promise<void> {
    return this.mutationOwner.restoreProject(projectId, token)
  }

  reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void> {
    return this.mutationOwner.reconcileActiveSessions(sessions)
  }

  reconcileProjectSessions(projectId: string, sessions: PersistedChatSession[]): Promise<void> {
    return this.mutationOwner.reconcileProjectSessions(projectId, sessions)
  }

  markReconciliationIncomplete(projectId?: string): void {
    this.mutationOwner.markReconciliationIncomplete(projectId)
  }

  async getOverview(
    request: string | GetProjectFilesOverviewRequest
  ): Promise<ProjectFilesOverview> {
    return this.queryOwner.getOverview(request)
  }

  async listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage> {
    return this.queryOwner.listFiles(request)
  }

  async resolveFile(request: ResolveProjectFileRequest): Promise<ProjectFileItem | undefined> {
    return this.queryOwner.resolveFile(request)
  }

  async readHostArtifactCatalog(request: {
    projectId: string
    versionId?: string
    finalizedArtifactsOnly?: boolean
  }): Promise<HostArtifactCatalogItem[]> {
    return this.queryOwner.readHostArtifactCatalog(request)
  }

  async searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult> {
    return this.queryOwner.searchArtifacts(request)
  }

  async listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage> {
    return this.queryOwner.listArtifactGroups(request)
  }
}

const createManagedFileIndexRepository = (
  getClientForRoot: ProjectFilesClientFactory,
  configRoot: string,
  dataRoot: string,
  legacyArtifactVersionAdopter: LegacyArtifactVersionAdopter,
  legacyUploadVersionUpgrader: LegacyUploadVersionUpgrader
): ManagedFileIndexRepository =>
  new ManagedFileIndexRepository(
    () => getClientForRoot(configRoot),
    dataRoot,
    legacyArtifactVersionAdopter,
    legacyUploadVersionUpgrader
  )

export { createManagedFileIndexRepository, ManagedFileIndexRepository }
export { ProjectFilesReconciliationError } from './mutation-owner'
export type {
  ManagedFileSoftDeleteToken,
  ProjectFilesClient,
  ProjectFilesClientFactory,
  ProjectFilesClientProvider,
  LegacyArtifactVersionAdopter,
  LegacyUploadVersionUpgrader
}
