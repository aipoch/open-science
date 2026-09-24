import type {
  SetArtifactHiddenRequest,
  ReadHiddenArtifactRequest,
  HiddenArtifactIdentity,
  ProjectFilesChangedEvent
} from '../../shared/project-files'
import type { ArtifactPreviewResult } from '../../shared/artifacts'
import { ipcMainHandle } from '../ipc-handler-registry'
import { createFileContentSearch, type SearchFileOpener } from './content-search'

import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ReadProjectExportFilesRequest,
  ProjectFilesOverview,
  ProjectFilesPage,
  ProjectFileItem,
  ResolveProjectFileRequest,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'

// Kept outside the composition root so browser exports exercise the real bounded lease contract.
export const readHiddenArtifactChunk = async (
  request: ReadHiddenArtifactRequest,
  open: (request: ReadHiddenArtifactRequest) => Promise<{
    size: number
    readRange(begin: number, end: number): Promise<Uint8Array>
    verifyUnchanged(): Promise<void>
    close(): Promise<void>
  }>
): Promise<ArtifactPreviewResult> => {
  const lease = await open(request)
  try {
    const offset = request.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > lease.size)
      throw new Error('Invalid hidden file offset.')
    const maxBytes = request.maxBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error('Invalid hidden file byte limit.')
    const limit = request.validationOnly
      ? 0
      : Math.min(lease.size - offset, maxBytes, 8 * 1024 * 1024)
    const bytes =
      limit === 0 ? Buffer.alloc(0) : Buffer.from(await lease.readRange(offset, offset + limit))
    await lease.verifyUnchanged()
    const encoding = request.encoding === 'base64' ? 'base64' : 'utf8'
    return {
      content: bytes.toString(encoding),
      encoding,
      size: lease.size,
      truncated: !request.validationOnly && offset + limit < lease.size
    }
  } finally {
    await lease.close()
  }
}

type ProjectFilesQueryRepository = {
  setArtifactHidden?(request: SetArtifactHiddenRequest): Promise<void>
  getHiddenArtifactIds?(projectId: string): Promise<HiddenArtifactIdentity[]>
  getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  readExportFiles(request: ReadProjectExportFilesRequest): Promise<ProjectFileItem[]>
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
  setArtifactHidden(request: SetArtifactHiddenRequest): Promise<void>
  getHiddenArtifactIds(request: { projectId: string }): Promise<HiddenArtifactIdentity[]>
  readHiddenArtifact(request: ReadHiddenArtifactRequest): Promise<ArtifactPreviewResult>
  getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
  listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
  readExportFiles(request: ReadProjectExportFilesRequest): Promise<ProjectFileItem[]>
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
  recoveryBackend: ProjectFilesRecoveryBackend,
  visibilityOrOpenSearch?:
    | {
        readHiddenArtifact(request: ReadHiddenArtifactRequest): Promise<ArtifactPreviewResult>
        onChanged(event: ProjectFilesChangedEvent): void
      }
    | SearchFileOpener,
  openSearchFile?: SearchFileOpener
): ProjectFilesHandlers => {
  const visibility =
    typeof visibilityOrOpenSearch === 'function' ? undefined : visibilityOrOpenSearch
  const searchOpener =
    typeof visibilityOrOpenSearch === 'function' ? visibilityOrOpenSearch : openSearchFile
  const searchContent = searchOpener ? createFileContentSearch(repository, searchOpener) : undefined
  return {
    setArtifactHidden: async (request) => {
      await recoveryBackend.waitForProjectOperations([request.projectId])
      if (!repository.setArtifactHidden || !visibility)
        throw new Error('Artifact visibility is unavailable.')
      await repository.setArtifactHidden(request)
      visibility.onChanged({
        projectId: request.projectId,
        sources: ['artifact'],
        kind: 'reset',
        artifactVisibilityChanged: true
      })
    },
    getHiddenArtifactIds: async ({ projectId }) => {
      await recoveryBackend.waitForProjectOperations([projectId])
      if (!repository.getHiddenArtifactIds) throw new Error('Artifact visibility is unavailable.')
      return repository.getHiddenArtifactIds(projectId)
    },
    readHiddenArtifact: async (request) => {
      await recoveryBackend.waitForProjectOperations([request.projectId])
      if (!visibility) throw new Error('Hidden artifact reader is unavailable.')
      return visibility.readHiddenArtifact(request)
    },
    getOverview: async (request) => {
      await recoveryBackend.waitForProjectOperations([request.projectId])
      return repository.getOverview(request)
    },
    listFiles: async (request) => {
      await recoveryBackend.waitForProjectOperations([request.projectId])
      return repository.listFiles(request)
    },
    readExportFiles: async (request) => {
      await recoveryBackend.waitForProjectOperations([request.projectId])
      return repository.readExportFiles(request)
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
        ...request.primaryProjectIds,
        ...request.otherProjectIds
      ])
      return request.searchContent && request.filenameContains?.trim() && searchContent
        ? searchContent(request)
        : repository.searchArtifacts(request)
    },
    repairIndex: async ({ projectId }) => {
      // repairProjectFiles performs a complete Session scan and global projection reconciliation.
      // Keep it behind strict recovery so it cannot touch another Project with a failed deletion tail.
      await recoveryBackend.recoverPendingDeletions()
      return repairBackend.repairProjectFiles(projectId)
    }
  }
}

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
  ipcMainHandle('project-files:set-artifact-hidden', (_event, request: SetArtifactHiddenRequest) =>
    handlers.setArtifactHidden(request)
  )
  ipcMainHandle('project-files:get-hidden-artifact-ids', (_event, request: { projectId: string }) =>
    handlers.getHiddenArtifactIds(request)
  )
  ipcMainHandle(
    'project-files:read-hidden-artifact',
    (_event, request: ReadHiddenArtifactRequest) => handlers.readHiddenArtifact(request)
  )
  ipcMainHandle('project-files:get-overview', (_event, request: GetProjectFilesOverviewRequest) =>
    handlers.getOverview(request)
  )
  ipcMainHandle('project-files:list-files', (_event, request: ListProjectFilesRequest) =>
    handlers.listFiles(request)
  )
  ipcMainHandle(
    'project-files:read-export-files',
    (_event, request: ReadProjectExportFilesRequest) => handlers.readExportFiles(request)
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
