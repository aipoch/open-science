import type {
  GetProjectFilesOverviewRequest,
  ReadProjectExportFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview
} from '../../../../shared/project-files'

type ListAllProjectFilesOptions = {
  getOverview: (request: GetProjectFilesOverviewRequest) => Promise<ProjectFilesOverview>
  readExportFiles: (request: ReadProjectExportFilesRequest) => Promise<ProjectFileItem[]>
  repairIndex: (request: { projectId: string }) => Promise<void>
  projectId: string
}

// Repairs the legacy index when needed, then reads one consistent export selection.
const listAllProjectFiles = async ({
  getOverview,
  readExportFiles,
  repairIndex,
  projectId
}: ListAllProjectFilesOptions): Promise<ProjectFileItem[]> => {
  let overview = await getOverview({ projectId })
  if (!overview.isIndexComplete) {
    await repairIndex({ projectId })
    overview = await getOverview({ projectId })
    if (!overview.isIndexComplete) {
      throw new Error('Some Project Files could not be indexed yet.')
    }
  }

  return readExportFiles({ projectId })
}

export { listAllProjectFiles }
export type { ListAllProjectFilesOptions }
