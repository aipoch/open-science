import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFilesOverview,
  ProjectFilesPage,
  ProjectFileItem,
  ResolveProjectFileRequest,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'

type ProjectFilesQueryRepository = {
  getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  resolveFile(request: ResolveProjectFileRequest): Promise<ProjectFileItem | undefined>
  listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
  searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult>
}

type ProjectFilesRepairBackend = {
  repairProjectFiles(projectId: string): Promise<void>
}

type ProjectFilesRecoveryBackend = {
  recoverPendingDeletions(): Promise<void>
  waitForProjectOperations(projectIds: readonly string[]): Promise<void>
}

type ProjectFilesHandlers = {
  getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  resolveFile(request: ResolveProjectFileRequest): Promise<ProjectFileItem | undefined>
  listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
  searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult>
  repairIndex(request: { projectId: string }): Promise<void>
}

// Keep Project-scoped recovery admission inside the testable handler layer so direct IPC registration
// cannot bypass the deletion gate for reads or repair.
const createProjectFilesHandlers = (
  repository: ProjectFilesQueryRepository,
  repairBackend: ProjectFilesRepairBackend,
  recoveryBackend: ProjectFilesRecoveryBackend
): ProjectFilesHandlers => ({
  getOverview: async (request) => {
    await recoveryBackend.waitForProjectOperations([request.projectId])
    return repository.getOverview(request)
  },
  listFiles: async (request) => {
    await recoveryBackend.waitForProjectOperations([request.projectId])
    return repository.listFiles(request)
  },
  resolveFile: async (request) => {
    await recoveryBackend.waitForProjectOperations([request.projectId])
    return repository.resolveFile(request)
  },
  listArtifactGroups: async (request) => {
    await recoveryBackend.waitForProjectOperations([request.projectId])
    return repository.listArtifactGroups(request)
  },
  searchArtifacts: async (request) => {
    await recoveryBackend.waitForProjectOperations([
      request.primaryProjectId,
      ...request.otherProjectIds
    ])
    return repository.searchArtifacts(request)
  },
  repairIndex: async ({ projectId }) => {
    // repairProjectFiles performs a complete Session scan and global projection reconciliation.
    // Keep it behind strict recovery so it cannot touch another Project with a failed deletion tail.
    await recoveryBackend.recoverPendingDeletions()
    return repairBackend.repairProjectFiles(projectId)
  }
})

// All Files operations wait on Project-scoped deletion recovery before reading or repairing metadata.
// This prevents a query from observing its Project midway through crash recovery without coupling it
// to failed deletion tails owned by other Projects.
const registerProjectFilesIpcHandlers = (
  repository: ProjectFilesQueryRepository,
  repairBackend: ProjectFilesRepairBackend,
  recoveryBackend: ProjectFilesRecoveryBackend,
  handlers: ProjectFilesHandlers = createProjectFilesHandlers(
    repository,
    repairBackend,
    recoveryBackend
  )
): void => {
  ipcMainHandle('project-files:get-overview', (_event, request: GetProjectFilesOverviewRequest) =>
    handlers.getOverview(request)
  )
  ipcMainHandle('project-files:list-files', (_event, request: ListProjectFilesRequest) =>
    handlers.listFiles(request)
  )
  ipcMainHandle('project-files:resolve-file', (_event, request: ResolveProjectFileRequest) =>
    handlers.resolveFile(request)
  )
  ipcMainHandle(
    'project-files:list-artifact-groups',
    (_event, request: ListArtifactGroupsRequest) => handlers.listArtifactGroups(request)
  )
  ipcMainHandle('project-files:search-artifacts', (_event, request: SearchArtifactsRequest) =>
    handlers.searchArtifacts(request)
  )
  ipcMainHandle('project-files:repair-index', (_event, request: { projectId: string }) =>
    handlers.repairIndex(request)
  )
}

export { createProjectFilesHandlers, registerProjectFilesIpcHandlers }
export type {
  ProjectFilesHandlers,
  ProjectFilesQueryRepository,
  ProjectFilesRecoveryBackend,
  ProjectFilesRepairBackend
}
