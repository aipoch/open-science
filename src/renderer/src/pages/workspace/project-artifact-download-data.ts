import type {
  GetProjectFilesOverviewRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview,
  ProjectFilesPage
} from '../../../../shared/project-files'

type ListAllProjectFilesOptions = {
  getOverview: (request: GetProjectFilesOverviewRequest) => Promise<ProjectFilesOverview>
  listFiles: (request: ListProjectFilesRequest) => Promise<ProjectFilesPage>
  repairIndex: (request: { projectId: string }) => Promise<void>
  projectId: string
}

const PROJECT_FILE_PAGE_LIMIT = 100

// Collects every Artifact and Upload in one Project through the flat 'all' collection, hiding cursor
// traversal so the download action receives one complete snapshot. Mirrors listAllSessionArtifacts.
const listAllProjectFiles = async ({
  getOverview,
  listFiles,
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

  const files: ProjectFileItem[] = []
  let cursor: string | undefined

  do {
    const page = await listFiles({
      projectId,
      collection: { kind: 'all' },
      ...(cursor ? { cursor } : {}),
      limit: PROJECT_FILE_PAGE_LIMIT
    })
    files.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)

  return files
}

export { listAllProjectFiles }
export type { ListAllProjectFilesOptions }
