import type {
  GetProjectFilesOverviewRequest,
  ReadProjectExportFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview
} from '../../../../shared/project-files'

type GetProjectFilesOverview = (
  request: GetProjectFilesOverviewRequest
) => Promise<ProjectFilesOverview>
type ReadExportFiles = (request: ReadProjectExportFilesRequest) => Promise<ProjectFileItem[]>
type RepairProjectFilesIndex = (request: { projectId: string }) => Promise<void>

type ListAllSessionArtifactsOptions = {
  getOverview: GetProjectFilesOverview
  readExportFiles: ReadExportFiles
  repairIndex: RepairProjectFilesIndex
  projectId: string
  sessionId: string
}

// Repairs the legacy index when needed, then reads one consistent export selection.
const listAllSessionArtifacts = async ({
  getOverview,
  readExportFiles,
  repairIndex,
  projectId,
  sessionId
}: ListAllSessionArtifactsOptions): Promise<ProjectFileItem[]> => {
  let overview = await getOverview({ projectId })
  if (!overview.isIndexComplete) {
    await repairIndex({ projectId })
    overview = await getOverview({ projectId })
    if (!overview.isIndexComplete) {
      throw new Error('Some Session Artifacts could not be indexed yet.')
    }
  }

  return readExportFiles({ projectId, sessionId })
}

export { listAllSessionArtifacts }
export type {
  GetProjectFilesOverview,
  ListAllSessionArtifactsOptions,
  ReadExportFiles,
  RepairProjectFilesIndex
}
