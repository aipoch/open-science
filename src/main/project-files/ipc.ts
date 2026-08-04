import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFilesOverview,
  ProjectFilesPage,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'

type ProjectFilesQueryRepository = {
  getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
  searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult>
}

type ProjectFilesRepairBackend = {
  repairProjectFiles(projectId: string): Promise<void>
}

type ProjectFilesRecoveryBackend = {
  recoverPendingDeletions(): Promise<void>
}

type ProjectFilesHandlers = {
  getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
  searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult>
  repairIndex(request: { projectId: string }): Promise<void>
}

// Keep recovery waiting inside the testable handler layer so direct IPC registration cannot bypass the
// sticky deletion gate for reads or repair.
const createProjectFilesHandlers = (
  repository: ProjectFilesQueryRepository,
  repairBackend: ProjectFilesRepairBackend,
  recoveryBackend: ProjectFilesRecoveryBackend
): ProjectFilesHandlers => ({
  getOverview: async (request) => {
    await recoveryBackend.recoverPendingDeletions()
    return repository.getOverview(request)
  },
  listFiles: async (request) => {
    await recoveryBackend.recoverPendingDeletions()
    return repository.listFiles(request)
  },
  listArtifactGroups: async (request) => {
    await recoveryBackend.recoverPendingDeletions()
    return repository.listArtifactGroups(request)
  },
  searchArtifacts: async (request) => {
    await recoveryBackend.recoverPendingDeletions()
    return repository.searchArtifacts(request)
  },
  repairIndex: async ({ projectId }) => {
    await recoveryBackend.recoverPendingDeletions()
    return repairBackend.repairProjectFiles(projectId)
  }
})

// All Files operations wait on the same project-deletion recovery gate before reading or repairing
// metadata. This prevents a query from observing rows midway through crash recovery.
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
