import { ipcMain } from 'electron'

import type {
  ArtifactGroupPage,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFilesOverview,
  ProjectFilesPage
} from '../../shared/project-files'

type ProjectFilesQueryRepository = {
  getOverview(projectId: string): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
}

type ProjectFilesRepairBackend = {
  repairProjectFiles(projectId: string): Promise<void>
}

type ProjectFilesRecoveryBackend = {
  recoverPendingDeletions(): Promise<void>
}

type ProjectFilesHandlers = {
  getOverview(request: { projectId: string }): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
  repairIndex(request: { projectId: string }): Promise<void>
}

// Keep recovery waiting inside the testable handler layer so direct IPC registration cannot bypass the
// sticky deletion gate for reads or repair.
const createProjectFilesHandlers = (
  repository: ProjectFilesQueryRepository,
  repairBackend: ProjectFilesRepairBackend,
  recoveryBackend: ProjectFilesRecoveryBackend
): ProjectFilesHandlers => ({
  getOverview: async ({ projectId }) => {
    await recoveryBackend.recoverPendingDeletions()
    return repository.getOverview(projectId)
  },
  listFiles: async (request) => {
    await recoveryBackend.recoverPendingDeletions()
    return repository.listFiles(request)
  },
  listArtifactGroups: async (request) => {
    await recoveryBackend.recoverPendingDeletions()
    return repository.listArtifactGroups(request)
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
  recoveryBackend: ProjectFilesRecoveryBackend
): void => {
  const handlers = createProjectFilesHandlers(repository, repairBackend, recoveryBackend)

  ipcMain.handle('project-files:get-overview', (_event, request: { projectId: string }) =>
    handlers.getOverview(request)
  )
  ipcMain.handle('project-files:list-files', (_event, request: ListProjectFilesRequest) =>
    handlers.listFiles(request)
  )
  ipcMain.handle(
    'project-files:list-artifact-groups',
    (_event, request: ListArtifactGroupsRequest) => handlers.listArtifactGroups(request)
  )
  ipcMain.handle('project-files:repair-index', (_event, request: { projectId: string }) =>
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
